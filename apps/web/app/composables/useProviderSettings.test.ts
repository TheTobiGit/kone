import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type {
  LegacyRendererProviderSettings,
  ProviderConfig,
  ProviderKind,
  ProviderSettingsMap,
  ProviderSettingsSnapshot,
} from "~/types/desktop";
import { resetProviderSettingsForTests, useProviderSettings } from "./useProviderSettings";

/** A stand-in for the preload's provider-settings bridge: one store however
 *  many windows subscribe, with the revision bump and broadcast a write causes. */
function installBridge(opts: {
  revision?: number;
  settings?: ProviderSettingsMap;
  legacyImportPending?: boolean;
  /** What importLegacySettings resolves to; defaults to the mirror as it was. */
  afterImport?: ProviderSettingsSnapshot;
  /** Answer with only the pre-snapshot calls, as an older preload would. */
  legacyApi?: boolean;
  /** Fail this many patchSettings writes, as a save that didn't land would. */
  failPatches?: number;
  /** Fail this many imports, as a store that couldn't be written would. */
  failImports?: number;
  /** Fail this many snapshot reads, as a startup IPC hiccup would. */
  failSnapshots?: number;
}) {
  let current: ProviderSettingsSnapshot = {
    revision: opts.revision ?? 1,
    settings: opts.settings ?? {},
    legacyImportPending: opts.legacyImportPending ?? false,
  };
  let failPatches = opts.failPatches ?? 0;
  let failImports = opts.failImports ?? 0;
  let failSnapshots = opts.failSnapshots ?? 0;
  const listeners = new Set<(snapshot: ProviderSettingsSnapshot) => void>();
  // Snapshots served before the store itself, so a second "window" can start
  // from what it read before the first one wrote.
  const served: ProviderSettingsSnapshot[] = [];
  let subscribeCalls = 0;
  const setCalls: Array<{ provider: ProviderKind; config: ProviderConfig }> = [];
  const patchCalls: Array<{ provider: ProviderKind; patch: ProviderConfig }> = [];
  const importCalls: LegacyRendererProviderSettings[] = [];

  const announce = (snapshot: ProviderSettingsSnapshot) => {
    for (const listener of listeners) listener(snapshot);
  };

  /** Main's write path: bump the revision, then tell every window. */
  const commit = (next: ProviderSettingsMap, legacyImportPending = current.legacyImportPending) => {
    current = { revision: current.revision + 1, settings: next, legacyImportPending };
    announce(current);
    return current;
  };

  type FakeAgent = {
    getSettings: () => Promise<ProviderSettingsMap>;
    setSettings: (provider: ProviderKind, config: ProviderConfig) => Promise<ProviderSettingsMap>;
    patchSettings?: (provider: ProviderKind, patch: ProviderConfig) => Promise<ProviderSettingsSnapshot>;
    getSettingsSnapshot?: () => Promise<ProviderSettingsSnapshot>;
    importLegacySettings?: (
      legacy: LegacyRendererProviderSettings,
    ) => Promise<ProviderSettingsSnapshot>;
    onSettingsChanged?: (cb: (snapshot: ProviderSettingsSnapshot) => void) => () => void;
  };

  const agent: FakeAgent = {
    getSettings: () => Promise.resolve(current.settings),
    setSettings: (provider, config) => {
      setCalls.push({ provider, config: { ...config } });
      commit({ ...current.settings, [provider]: { ...config } });
      return Promise.resolve(current.settings);
    },
  };
  if (!opts.legacyApi) {
    agent.getSettingsSnapshot = () => {
      if (failSnapshots > 0) {
        failSnapshots -= 1;
        return Promise.reject(new Error("ipc not ready"));
      }
      return Promise.resolve(served.shift() ?? current);
    };
    agent.patchSettings = (provider, patch) => {
      patchCalls.push({ provider, patch: { ...patch } });
      if (failPatches > 0) {
        failPatches -= 1;
        return Promise.reject(new Error("settings not saved"));
      }
      const merged: ProviderConfig = { ...current.settings[provider], ...patch };
      for (const [key, value] of Object.entries(patch)) {
        // An `undefined` value clears the field, as main's merge does.
        if (value === undefined) Reflect.deleteProperty(merged, key);
      }
      return Promise.resolve(commit({ ...current.settings, [provider]: merged }));
    };
    agent.importLegacySettings = (legacy) => {
      importCalls.push(legacy);
      if (failImports > 0) {
        failImports -= 1;
        return Promise.reject(new Error("import not saved"));
      }
      if (opts.afterImport) {
        current = opts.afterImport;
        announce(current);
      } else {
        commit(current.settings, false);
      }
      return Promise.resolve(current);
    };
    agent.onSettingsChanged = (cb) => {
      subscribeCalls += 1;
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    };
  }

  // SAFETY: the composable reads only window.koneDesktop.agent's settings
  // calls, which this host provides; nothing else here touches window.
  (globalThis as { window?: unknown }).window = { koneDesktop: { agent } };
  return {
    setCalls,
    patchCalls,
    importCalls,
    /** Main's store as it stands now. */
    main: (): ProviderSettingsMap => current.settings,
    /** Serve one stale snapshot to the next read, as a window that lived
     *  through a write in another window would still hold. */
    serveNext: (stale: ProviderSettingsSnapshot) => {
      served.push(stale);
    },
    /** Push a snapshot the way main broadcasts after a write. */
    push: (next: ProviderSettingsSnapshot) => {
      announce(next);
    },
    /** How many times a surface asked to be told about writes. */
    subscribeCalls: () => subscribeCalls,
  };
}

/** In-memory localStorage so a test can prove nothing is persisted. */
function installStorage(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  const writes: Array<[string, string]> = [];
  const storage: Storage = {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => {
      writes.push([key, String(value)]);
      store.set(key, String(value));
    },
    removeItem: (key) => {
      store.delete(key);
    },
    clear: () => store.clear(),
    key: (index) => Array.from(store.keys())[index] ?? null,
    get length() {
      return store.size;
    },
  };
  // SAFETY: the composable only reads and removes the two legacy keys off
  // localStorage; this stub is a full Storage.
  (globalThis as { localStorage?: Storage }).localStorage = storage;
  return { writes, store };
}

// Restore the exact host slots: leaving an empty window behind makes later
// browser-aware imports mistake Bun for a browser (for example useTheme).
// SAFETY: only the optional window/localStorage slots are read or restored.
const host = globalThis as { window?: unknown; localStorage?: unknown };
let savedWindow: unknown;
let hadWindow: boolean;
let savedStorage: unknown;
let hadStorage: boolean;

beforeEach(() => {
  hadWindow = "window" in globalThis;
  savedWindow = host.window;
  hadStorage = "localStorage" in globalThis;
  savedStorage = host.localStorage;
  resetProviderSettingsForTests();
});

afterEach(() => {
  if (hadWindow) host.window = savedWindow;
  else delete host.window;
  if (hadStorage) host.localStorage = savedStorage;
  else delete host.localStorage;
});

const snapshot = (
  revision: number,
  settings: ProviderSettingsMap,
  legacyImportPending = false,
): ProviderSettingsSnapshot => ({ revision, settings, legacyImportPending });

describe("useProviderSettings: main-process mirror", () => {
  test("load applies the snapshot, including what main has hidden", async () => {
    installBridge({
      revision: 7,
      settings: {
        codex: { enabled: false },
        claudeAgent: { hiddenModels: ["opus"] },
        opencode: { binaryPath: "/opt/bin/opencode" },
      },
    });
    const settings = useProviderSettings();
    await settings.load();

    expect(settings.isEnabled("codex")).toBe(false);
    expect(settings.isEnabled("claudeAgent")).toBe(true);
    expect(settings.isModelHidden("claudeAgent", "opus")).toBe(true);
    expect(settings.isModelHidden("codex", "gpt-5")).toBe(false);
    expect(settings.binaryPath("opencode")).toBe("/opt/bin/opencode");
  });

  test("a push from main updates the mirror; a stale one is ignored", async () => {
    const bridge = installBridge({ revision: 4, settings: { codex: { enabled: true } } });
    const settings = useProviderSettings();
    await settings.load();

    bridge.push(snapshot(5, { codex: { enabled: false } }));
    expect(settings.isEnabled("codex")).toBe(false);

    bridge.push(snapshot(3, { codex: { enabled: true } }));
    bridge.push(snapshot(5, { codex: { enabled: true } }));
    expect(settings.isEnabled("codex")).toBe(false);

    // However many surfaces reload, the window is subscribed once.
    await settings.load(true);
    expect(bridge.subscribeCalls()).toBe(1);
  });

  test("a toggle sends only the field it changed, and shows at once", async () => {
    const bridge = installBridge({
      revision: 2,
      settings: { codex: { enabled: true, binaryPath: "/opt/codex", handoffTokenCap: 2000 } },
    });
    const settings = useProviderSettings();
    await settings.load();

    const pending = settings.setEnabled("codex", false);
    expect(settings.isEnabled("codex")).toBe(false);
    await pending;
    expect(bridge.patchCalls[0]).toEqual({ provider: "codex", patch: { enabled: false } });
    expect(bridge.main().codex).toEqual({
      enabled: false,
      binaryPath: "/opt/codex",
      handoffTokenCap: 2000,
    });

    settings.setModelHidden("codex", "gpt-5", true);
    expect(settings.isModelHidden("codex", "gpt-5")).toBe(true);
    expect(bridge.patchCalls[1]).toEqual({ provider: "codex", patch: { hiddenModels: ["gpt-5"] } });
    expect(bridge.main().codex).toEqual({
      enabled: false,
      binaryPath: "/opt/codex",
      handoffTokenCap: 2000,
      hiddenModels: ["gpt-5"],
    });

    // main's answer is the last word, even when it disagrees with the optimism
    bridge.push(snapshot(9, { codex: { enabled: true, binaryPath: "/opt/codex" } }));
    expect(settings.isEnabled("codex")).toBe(true);
    expect(settings.isModelHidden("codex", "gpt-5")).toBe(false);
  });

  test("a binary path writes only that field, clearing when blank", async () => {
    const bridge = installBridge({
      revision: 1,
      settings: { codex: { enabled: false, binaryPath: "/opt/codex" } },
    });
    const settings = useProviderSettings();
    await settings.load();

    await settings.setBinaryPath("codex", " /usr/local/bin/codex ");
    expect(settings.binaryPath("codex")).toBe("/usr/local/bin/codex");
    expect(bridge.patchCalls[0]?.patch).toEqual({ binaryPath: "/usr/local/bin/codex" });

    await settings.setBinaryPath("codex", "  ");
    expect(settings.binaryPath("codex")).toBe("");
    expect(bridge.patchCalls[1]?.patch).toEqual({ binaryPath: undefined });
    expect(bridge.main().codex).toEqual({ enabled: false });
  });

  test("nothing is persisted in localStorage any more", async () => {
    const { writes } = installStorage();
    const bridge = installBridge({ revision: 1, settings: { codex: { enabled: true } } });
    const settings = useProviderSettings();
    await settings.load();
    await settings.setEnabled("codex", false);
    settings.setModelHidden("codex", "gpt-5", true);

    expect(writes).toEqual([]);
    expect(bridge.patchCalls).toHaveLength(2);
  });

  test("a preload without the snapshot calls still reads and writes", async () => {
    const bridge = installBridge({
      revision: 1,
      settings: { codex: { enabled: true, binaryPath: "/opt/codex" } },
      legacyApi: true,
    });
    const settings = useProviderSettings();
    await settings.load();
    expect(settings.binaryPath("codex")).toBe("/opt/codex");

    await settings.setEnabled("codex", false);
    expect(settings.isEnabled("codex")).toBe(false);
    expect(settings.binaryPath("codex")).toBe("/opt/codex");
    // No patchSettings on an old preload: the whole entry replaces the old one.
    expect(bridge.setCalls[0]).toEqual({
      provider: "codex",
      config: { enabled: false, binaryPath: "/opt/codex" },
    });
  });
});

describe("useProviderSettings: limit behaviour", () => {
  test("both limit toggles read their defaults with nothing stored", async () => {
    installBridge({ revision: 1, settings: {} });
    const settings = useProviderSettings();
    await settings.load();

    // Absent means today's behaviour: kone resumes at the reset and never snoozes.
    expect(settings.resumeAtReset("codex")).toBe(true);
    expect(settings.snoozeWhenLimited("codex")).toBe(false);
  });

  test("each toggle writes only its own field and shows at once", async () => {
    const bridge = installBridge({
      revision: 3,
      settings: { codex: { enabled: true, binaryPath: "/opt/codex" } },
    });
    const settings = useProviderSettings();
    await settings.load();

    const pending = settings.setResumeAtReset("codex", false);
    expect(settings.resumeAtReset("codex")).toBe(false);
    await pending;
    expect(bridge.patchCalls[0]).toEqual({ provider: "codex", patch: { resumeAtReset: false } });

    await settings.setSnoozeWhenLimited("codex", true);
    expect(settings.snoozeWhenLimited("codex")).toBe(true);
    expect(bridge.patchCalls[1]).toEqual({ provider: "codex", patch: { snoozeWhenLimited: true } });

    // Each write carried one field, so the provider's other settings survived.
    expect(bridge.main().codex).toEqual({
      enabled: true,
      binaryPath: "/opt/codex",
      resumeAtReset: false,
      snoozeWhenLimited: true,
    });
  });

  test("a stored off/on reads back through the mirror, and a push overrules it", async () => {
    const bridge = installBridge({
      revision: 6,
      settings: { codex: { resumeAtReset: false, snoozeWhenLimited: true } },
    });
    const settings = useProviderSettings();
    await settings.load();
    expect(settings.resumeAtReset("codex")).toBe(false);
    expect(settings.snoozeWhenLimited("codex")).toBe(true);

    bridge.push(snapshot(7, { codex: { resumeAtReset: true, snoozeWhenLimited: false } }));
    expect(settings.resumeAtReset("codex")).toBe(true);
    expect(settings.snoozeWhenLimited("codex")).toBe(false);
  });
});

describe("useProviderSettings: failed first read", () => {
  test("a snapshot read that fails is retried by the next load", async () => {
    installStorage({});
    installBridge({ revision: 3, settings: { codex: { enabled: false } }, failSnapshots: 1 });
    const settings = useProviderSettings();
    await settings.load();
    expect(settings.isEnabled("codex")).toBe(true);

    await settings.load();
    expect(settings.isEnabled("codex")).toBe(false);
  });
});

describe("useProviderSettings: concurrent writes", () => {
  test("two windows editing different fields both keep their change", async () => {
    const bridge = installBridge({ revision: 1, settings: { codex: { enabled: true } } });
    const windowA = useProviderSettings();
    await windowA.load();
    await windowA.setEnabled("codex", false);
    expect(bridge.main().codex).toEqual({ enabled: false });

    // Window B loaded the same stale store before A wrote. Module state is one
    // mirror per process, so it starts over from the snapshot it still holds.
    resetProviderSettingsForTests();
    bridge.serveNext(snapshot(1, { codex: { enabled: true } }));
    const windowB = useProviderSettings();
    await windowB.load();
    expect(windowB.isEnabled("codex")).toBe(true);

    windowB.setModelHidden("codex", "gpt-5", true);

    // Each window sent only its own field, so neither undid the other.
    expect(bridge.patchCalls).toEqual([
      { provider: "codex", patch: { enabled: false } },
      { provider: "codex", patch: { hiddenModels: ["gpt-5"] } },
    ]);
    expect(bridge.main().codex).toEqual({ enabled: false, hiddenModels: ["gpt-5"] });
    expect(windowB.isEnabled("codex")).toBe(false);
    expect(windowB.isModelHidden("codex", "gpt-5")).toBe(true);
  });

  test("a save that fails puts main's value back", async () => {
    const bridge = installBridge({
      revision: 5,
      settings: { codex: { enabled: true } },
      failPatches: 1,
    });
    const settings = useProviderSettings();
    await settings.load();

    const pending = settings.setEnabled("codex", false);
    expect(settings.isEnabled("codex")).toBe(false);
    await pending;

    // Main never moved, so neither does the mirror — at the same revision.
    expect(settings.isEnabled("codex")).toBe(true);
    expect(bridge.main().codex).toEqual({ enabled: true });
  });
});

describe("useProviderSettings: legacy import", () => {
  test("pending import is lifted once, applied, and the keys are dropped", async () => {
    const { store } = installStorage({
      "kone.providers.enabled": JSON.stringify({ codex: false }),
      "kone.models.hidden": JSON.stringify({ claudeAgent: ["opus"] }),
    });
    const bridge = installBridge({
      revision: 1,
      legacyImportPending: true,
      afterImport: snapshot(2, {
        codex: { enabled: false },
        claudeAgent: { hiddenModels: ["opus"] },
      }),
    });
    const settings = useProviderSettings();
    await settings.load();

    expect(bridge.importCalls).toEqual([
      { enabled: { codex: false }, hiddenModels: { claudeAgent: ["opus"] } },
    ]);
    expect(settings.isEnabled("codex")).toBe(false);
    expect(settings.isModelHidden("claudeAgent", "opus")).toBe(true);
    expect(store.has("kone.providers.enabled")).toBe(false);
    expect(store.has("kone.models.hidden")).toBe(false);

    await settings.load(true);
    expect(bridge.importCalls).toHaveLength(1);
  });

  test("an already-imported store never calls the importer and drops leftovers", async () => {
    const { store } = installStorage({
      "kone.providers.enabled": JSON.stringify({ codex: false }),
      "kone.models.hidden": JSON.stringify({ codex: ["gpt-5"] }),
    });
    const bridge = installBridge({ revision: 3, settings: { codex: { enabled: true } } });
    const settings = useProviderSettings();
    await settings.load();

    expect(bridge.importCalls).toEqual([]);
    expect(settings.isEnabled("codex")).toBe(true);
    expect(store.size).toBe(0);
  });

  test("garbage in the legacy keys is treated as absent, not fatal", async () => {
    installStorage({ "kone.providers.enabled": "{not json" });
    const bridge = installBridge({ revision: 1, legacyImportPending: true });
    const settings = useProviderSettings();
    await settings.load();

    expect(bridge.importCalls).toEqual([{}]);
    expect(settings.isEnabled("codex")).toBe(true);
  });

  test("an import that can't be saved keeps the keys and retries on the next load", async () => {
    const { store } = installStorage({
      "kone.providers.enabled": JSON.stringify({ codex: false }),
    });
    const bridge = installBridge({
      revision: 1,
      legacyImportPending: true,
      afterImport: snapshot(2, { codex: { enabled: false } }),
      failImports: 1,
    });
    const settings = useProviderSettings();
    await settings.load();

    // Main's store as it stood, not the choices the import couldn't keep.
    expect(settings.isEnabled("codex")).toBe(true);
    expect(store.has("kone.providers.enabled")).toBe(true);

    // A plain load() tries again — no background loop, just the next caller.
    await settings.load();
    expect(bridge.importCalls).toHaveLength(2);
    expect(settings.isEnabled("codex")).toBe(false);
    expect(store.has("kone.providers.enabled")).toBe(false);
  });

  test("an import that lands but leaves the store pending keeps the keys", async () => {
    const { store } = installStorage({
      "kone.providers.enabled": JSON.stringify({ codex: false }),
    });
    installBridge({
      revision: 1,
      legacyImportPending: true,
      afterImport: snapshot(2, { codex: { enabled: false } }, true),
    });
    const settings = useProviderSettings();
    await settings.load();

    expect(settings.isEnabled("codex")).toBe(false);
    expect(store.has("kone.providers.enabled")).toBe(true);
  });
});

describe("useProviderSettings: browser fallback", () => {
  test("without a bridge, toggles live in memory only", async () => {
    const { writes } = installStorage();
    const settings = useProviderSettings();
    await settings.load();

    expect(settings.isEnabled("codex")).toBe(true);
    await settings.setEnabled("codex", false);
    settings.setModelHidden("codex", "gpt-5", true);
    expect(settings.isEnabled("codex")).toBe(false);
    expect(settings.isModelHidden("codex", "gpt-5")).toBe(true);
    expect(writes).toEqual([]);
  });
});

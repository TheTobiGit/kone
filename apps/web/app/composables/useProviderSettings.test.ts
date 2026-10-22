import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type {
  LegacyRendererProviderSettings,
  ProviderConfig,
  ProviderKind,
  ProviderSettingsMap,
  ProviderSettingsSnapshot,
} from "~/types/desktop";
import { resetProviderSettingsForTests, useProviderSettings } from "./useProviderSettings";

/** A stand-in for the preload's provider-settings bridge: it keeps the snapshot
 *  the main process would hold, records writes, and lets a test push. */
function installBridge(opts: {
  revision?: number;
  settings?: ProviderSettingsMap;
  legacyImportPending?: boolean;
  /** What importLegacySettings resolves to; defaults to the mirror as it was. */
  afterImport?: ProviderSettingsSnapshot;
  /** Answer with only the pre-snapshot calls, as an older preload would. */
  legacyApi?: boolean;
}) {
  let current: ProviderSettingsSnapshot = {
    revision: opts.revision ?? 1,
    settings: opts.settings ?? {},
    legacyImportPending: opts.legacyImportPending ?? false,
  };
  let listener: ((snapshot: ProviderSettingsSnapshot) => void) | null = null;
  let subscribeCalls = 0;
  const setCalls: Array<{ provider: ProviderKind; config: ProviderConfig }> = [];
  const importCalls: LegacyRendererProviderSettings[] = [];

  type FakeAgent = {
    getSettings: () => Promise<ProviderSettingsMap>;
    setSettings: (provider: ProviderKind, config: ProviderConfig) => Promise<ProviderSettingsMap>;
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
      current = {
        revision: current.revision + 1,
        settings: { ...current.settings, [provider]: { ...config } },
        legacyImportPending: current.legacyImportPending,
      };
      return Promise.resolve(current.settings);
    },
  };
  if (!opts.legacyApi) {
    agent.getSettingsSnapshot = () => Promise.resolve(current);
    agent.importLegacySettings = (legacy) => {
      importCalls.push(legacy);
      current = opts.afterImport ?? {
        revision: current.revision + 1,
        settings: current.settings,
        legacyImportPending: false,
      };
      return Promise.resolve(current);
    };
    agent.onSettingsChanged = (cb) => {
      subscribeCalls += 1;
      listener = cb;
      return () => {
        listener = null;
      };
    };
  }

  // SAFETY: the composable reads only window.koneDesktop.agent's settings
  // calls, which this host provides; nothing else here touches window.
  (globalThis as { window?: unknown }).window = { koneDesktop: { agent } };
  return {
    setCalls,
    importCalls,
    /** Push a snapshot the way main broadcasts after a write. */
    push: (snapshot: ProviderSettingsSnapshot) => listener?.(snapshot),
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

  test("a toggle writes the merged config and shows at once", async () => {
    const bridge = installBridge({
      revision: 2,
      settings: { codex: { enabled: true, binaryPath: "/opt/codex", handoffTokenCap: 2000 } },
    });
    const settings = useProviderSettings();
    await settings.load();

    const pending = settings.setEnabled("codex", false);
    expect(settings.isEnabled("codex")).toBe(false);
    await pending;
    expect(bridge.setCalls[0]).toEqual({
      provider: "codex",
      config: { enabled: false, binaryPath: "/opt/codex", handoffTokenCap: 2000 },
    });

    settings.setModelHidden("codex", "gpt-5", true);
    expect(settings.isModelHidden("codex", "gpt-5")).toBe(true);
    expect(bridge.setCalls[1]).toEqual({
      provider: "codex",
      config: {
        enabled: false,
        binaryPath: "/opt/codex",
        handoffTokenCap: 2000,
        hiddenModels: ["gpt-5"],
      },
    });

    // main's answer is the last word, even when it disagrees with the optimism
    bridge.push(snapshot(9, { codex: { enabled: true, binaryPath: "/opt/codex" } }));
    expect(settings.isEnabled("codex")).toBe(true);
    expect(settings.isModelHidden("codex", "gpt-5")).toBe(false);
  });

  test("a binary path writes through the same path, clearing when blank", async () => {
    const bridge = installBridge({
      revision: 1,
      settings: { codex: { enabled: false, binaryPath: "/opt/codex" } },
    });
    const settings = useProviderSettings();
    await settings.load();

    await settings.setBinaryPath("codex", " /usr/local/bin/codex ");
    expect(settings.binaryPath("codex")).toBe("/usr/local/bin/codex");
    expect(bridge.setCalls[0]?.config).toEqual({
      enabled: false,
      binaryPath: "/usr/local/bin/codex",
    });

    await settings.setBinaryPath("codex", "  ");
    expect(settings.binaryPath("codex")).toBe("");
    expect(bridge.setCalls[1]?.config).toEqual({ enabled: false, binaryPath: undefined });
  });

  test("nothing is persisted in localStorage any more", async () => {
    const { writes } = installStorage();
    const bridge = installBridge({ revision: 1, settings: { codex: { enabled: true } } });
    const settings = useProviderSettings();
    await settings.load();
    await settings.setEnabled("codex", false);
    settings.setModelHidden("codex", "gpt-5", true);

    expect(writes).toEqual([]);
    expect(bridge.setCalls).toHaveLength(2);
  });

  test("a preload without the snapshot calls still reads and writes", async () => {
    installBridge({
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

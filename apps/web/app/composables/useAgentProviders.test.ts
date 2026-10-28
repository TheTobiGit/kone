import { expect, test } from "bun:test";
import type {
  ModelDescriptor, ProviderKind, ProviderModelsRefreshResult, ProviderStatus, ProviderSurfaceSnapshot,
} from "~/types/desktop";
import { createDevBridge } from "~/lib/devBridge";
import { installDevBridge } from "~/utils/desktopBridge";
import { useAgentProviders } from "./useAgentProviders";

// The app-lifetime provider listener is installed by the composable itself, not
// by prepare(): Settings can be opened straight from the home screen with
// nothing having prepared the surface, and a sign-in verified there still has to
// move the row. This drives that path through a stand-in bridge.

function cursor(overrides: Partial<ProviderStatus> = {}): ProviderStatus {
  return {
    provider: "cursor",
    label: "Cursor",
    available: true,
    authStatus: "unauthenticated",
    readiness: "needs-login",
    ...overrides,
  };
}

/** The handful of members the provider listener touches on `window`/`document`. */
type StubGlobal = {
  addEventListener: () => void;
  visibilityState?: "visible";
};

/** Put a browser global in place for one test and hand back its undo. */
function setGlobal(name: "window" | "document", value: StubGlobal): () => void {
  const prior = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  return () => {
    if (prior) Object.defineProperty(globalThis, name, prior);
    else Reflect.deleteProperty(globalThis, name);
  };
}

/** The listener's browser globals, for the duration of one test. */
async function withWindow(run: () => Promise<void>): Promise<void> {
  const restoreDocument = setGlobal("document", {
    addEventListener: () => {},
    visibilityState: "visible",
  });
  const restoreWindow = setGlobal("window", { addEventListener: () => {} });
  try {
    await run();
  } finally {
    restoreWindow();
    restoreDocument();
  }
}

test("provider and catalog changes from main land without prepare() or a focus refresh", async () => {
  await withWindow(async () => {
    const listeners: ((next: ProviderStatus[]) => void)[] = [];
    const modelListeners: ((provider: ProviderKind, models: ModelDescriptor[]) => void)[] = [];
    const oldQuery = Promise.withResolvers<ModelDescriptor[]>();
    const oldSurface = Promise.withResolvers<ProviderSurfaceSnapshot>();
    const surfaceStarted = Promise.withResolvers<void>();
    let modelCalls = 0;
    const base = createDevBridge();
    installDevBridge({
      ...base,
      agent: {
        ...base.agent,
        onProvidersChanged: (cb) => {
          listeners.push(cb);
          return () => {
            const at = listeners.indexOf(cb);
            if (at >= 0) listeners.splice(at, 1);
          };
        },
        onModelsChanged: (cb) => {
          modelListeners.push(cb);
          return () => {};
        },
        models: () => {
          modelCalls += 1;
          return oldQuery.promise;
        },
        surface: () => {
          surfaceStarted.resolve();
          return oldSurface.promise;
        },
      },
    });

    const providers = useAgentProviders();
    // Merely asking for the store is enough to subscribe.
    const announce = listeners[0];
    if (!announce) throw new Error("the provider listener was not installed");

    announce([cursor()]);
    expect(providers.byProvider("cursor").value?.readiness).toBe("needs-login");
    expect(providers.ready.value).toEqual([]);

    // The verified sign-in: the row the Providers pane reads turns ready.
    announce([
      cursor({ readiness: "ready", authStatus: "authenticated", authLabel: "Cursor Pro" }),
    ]);
    expect(providers.ready.value.map((status) => status.provider)).toEqual(["cursor"]);

    providers.modelCache.value = {
      cursor: [{ id: "old-account-model", label: "Old account" }],
      codex: [{ id: "unaffected-model", label: "Unaffected" }],
    };
    const pending = providers.models("cursor", true);
    const freshModels = [{ id: "new-account-model", label: "New account" }];
    for (const listener of modelListeners) listener("cursor", freshModels);
    expect(providers.modelCache.value.cursor).toEqual(freshModels);
    expect(providers.modelCache.value.codex).toEqual([{ id: "unaffected-model", label: "Unaffected" }]);
    expect(await providers.models("cursor")).toEqual(freshModels);
    expect(modelCalls).toBe(1);

    // An IPC response captured before the push must not restore the old list.
    oldQuery.resolve([{ id: "old-account-model", label: "Old account" }]);
    expect(await pending).toEqual(freshModels);
    expect(providers.modelCache.value.cursor).toEqual(freshModels);

    const refreshing = providers.refresh();
    await surfaceStarted.promise;
    const latestModels = [{ id: "latest-account-model", label: "Latest account" }];
    for (const listener of modelListeners) listener("cursor", latestModels);
    oldSurface.resolve({
      version: 1, savedAt: 0, statuses: [], models: { cursor: freshModels },
    });
    await refreshing;
    expect(providers.modelCache.value.cursor).toEqual(latestModels);

    const oldRefresh = Promise.withResolvers<ProviderModelsRefreshResult>();
    // refreshModels reads the preload directly; only its one method is needed here.
    Object.defineProperty(window, "koneDesktop", {
      value: { agent: { refreshModels: () => oldRefresh.promise } }, configurable: true,
    });
    const refreshingModels = providers.refreshModels("cursor");
    for (const listener of modelListeners) listener("cursor", freshModels);
    oldRefresh.resolve({ provider: "cursor", models: latestModels });
    expect(await refreshingModels).toEqual({ models: freshModels, error: null });
    expect(providers.modelCache.value.cursor).toEqual(freshModels);
  });
});

test("adding and removing the sole custom model updates modelCache immediately", async () => {
  const { resetProviderSettingsForTests, useProviderSettings } = await import(
    "./useProviderSettings"
  );
  resetProviderSettingsForTests();
  const ps = useProviderSettings();
  const providers = useAgentProviders();
  providers.modelCache.value = {};

  await ps.addCustomModel("codex", "o3-pro");
  expect(providers.modelCache.value.codex?.map((m) => m.id)).toEqual(["o3-pro"]);

  // Simulate IPC returning the custom model in rawModelCache, then removing it:
  providers.modelCache.value = { codex: [{ id: "o3-pro", label: "o3-pro", custom: true }] };
  await ps.removeCustomModel("codex", "o3-pro");
  expect(providers.modelCache.value.codex ?? []).toEqual([]);
});

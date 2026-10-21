import { expect, test } from "bun:test";
import type { ProviderStatus } from "~/types/desktop";
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
function withWindow(run: () => void): void {
  const restoreDocument = setGlobal("document", {
    addEventListener: () => {},
    visibilityState: "visible",
  });
  const restoreWindow = setGlobal("window", { addEventListener: () => {} });
  try {
    run();
  } finally {
    restoreWindow();
    restoreDocument();
  }
}

test("a provider change from the main process lands without prepare()", () => {
  withWindow(() => {
    const listeners: ((next: ProviderStatus[]) => void)[] = [];
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
  });
});

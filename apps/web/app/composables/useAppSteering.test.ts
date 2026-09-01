import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { initAppSteering } from "./useAppSteering";
import { useTheme } from "./useTheme";
import { findTheme, isCustom, removeCustomTheme, themes } from "~/theme/library";
import type { RuntimeEvent } from "~/types/desktop";

type ThemeMutation = Extract<RuntimeEvent, { type: "app.theme_mutation" }>;

/** The slice of the desktop bridge the composable actually reaches for. */
type BridgeHost = { koneDesktop: { agent: { onEvent: (fn: (e: RuntimeEvent) => void) => () => void } } };

/** Stands in for the desktop bridge: captures the listener the composable
 *  registers so a test can hand it an event the way the shell would. */
function installBridge() {
  let listener: ((event: RuntimeEvent) => void) | null = null;
  const host: BridgeHost = {
    koneDesktop: {
      agent: {
        onEvent: (fn) => {
          listener = fn;
          return () => {
            listener = null;
          };
        },
      },
    },
  };
  // SAFETY: the composable reads only window.koneDesktop.agent.onEvent, which
  // BridgeHost provides; nothing else in this file touches window.
  (globalThis as { window?: BridgeHost }).window = host;
  return {
    emit: (event: ThemeMutation) => listener?.(event),
    teardown: () => {
      listener = null;
    },
  };
}

function mutation(fields: Partial<ThemeMutation>): ThemeMutation {
  // SAFETY: the composable branches only on the fields spread in here.
  return {
    type: "app.theme_mutation",
    threadId: "thread-1",
    provider: "claudeAgent",
    at: Date.now(),
    source: "kone.store",
    ...fields,
  } as ThemeMutation;
}

describe("useAppSteering", () => {
  let bridge: ReturnType<typeof installBridge>;
  let stop: () => void;

  beforeEach(() => {
    bridge = installBridge();
    stop = initAppSteering();
  });

  afterEach(() => {
    stop();
    bridge.teardown();
    for (const t of themes.value) {
      if (isCustom(t.id)) removeCustomTheme(t.id);
    }
    useTheme().setTheme("kone");
  });

  it("applies a theme the library holds", () => {
    bridge.emit(mutation({ themeId: "nocturne" }));
    expect(useTheme().themeId.value).toBe("nocturne");
  });

  // The library resolves an unknown id to kone, so storing it unchecked would
  // persist a preference that renders as a different theme on every later boot.
  it("ignores a theme the library does not hold", () => {
    const { themeId, setTheme } = useTheme();
    setTheme("nocturne");

    bridge.emit(mutation({ themeId: "dracula" }));

    expect(themeId.value).toBe("nocturne");
  });

  it("applies a bare mode change without touching the theme", () => {
    const { themeId, mode, setTheme } = useTheme();
    setTheme("kone");

    bridge.emit(mutation({ mode: "dark" }));

    expect(mode.value).toBe("dark");
    expect(themeId.value).toBe("kone");
  });

  it("registers a custom theme and makes it the active one", () => {
    bridge.emit(
      mutation({
        themeId: "brand-indigo",
        customTheme: {
          id: "brand-indigo",
          label: "Brand Indigo",
          appearance: "dark",
          accent: "#6366f1",
          ground: "#0f172a",
        },
      }),
    );

    const created = findTheme("brand-indigo");
    expect(created).not.toBeNull();
    expect(created?.label).toBe("Brand Indigo");
    expect(useTheme().themeId.value).toBe("brand-indigo");
  });

  it("cancels a preview without disturbing the saved theme", () => {
    const { themeId, setTheme } = useTheme();
    setTheme("moss");

    bridge.emit(mutation({ preview: true, themeId: "tide" }));
    bridge.emit(mutation({ preview: false }));

    expect(themeId.value).toBe("moss");
  });
});

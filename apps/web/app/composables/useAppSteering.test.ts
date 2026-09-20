import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { initAppSteering } from "./useAppSteering";
import { useTheme } from "./useTheme";
import { findTheme, isCustom, removeCustomTheme, themes } from "~/theme/library";
import { agentById, agentRoster, projectTeam } from "~/utils/agents";
import { agentRows, projectTeams } from "~/utils/agentStore";
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
    emit: (event: RuntimeEvent) => listener?.(event),
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
    turnId: "turn-1",
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

  // Both ends of the change travel with the tool call's own stored record, so
  // applying here leaves nothing behind to assert — the record is written by
  // the tool and read back by the transcript row.
  it("cancels a preview without disturbing the saved theme", () => {
    const { themeId, setTheme } = useTheme();
    setTheme("moss");

    bridge.emit(mutation({ preview: true, themeId: "tide" }));
    bridge.emit(mutation({ preview: false }));

    expect(themeId.value).toBe("moss");
  });
});

type AgentMutation = Extract<RuntimeEvent, { type: "app.agent_mutation" }>;

function agentMutation(fields: Partial<AgentMutation>): AgentMutation {
  // SAFETY: the composable branches only on the fields spread in here.
  return {
    type: "app.agent_mutation",
    threadId: "thread-1",
    turnId: "turn-1",
    provider: "claudeAgent",
    at: Date.now(),
    source: "kone.store",
    ...fields,
  } as AgentMutation;
}

/** The mutation is applied on a fire-and-forget promise, so a test hands the
 *  event over and then waits out the store writes. */
function flushSteering(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 10));
}

describe("useAppSteering agent roster", () => {
  let bridge: ReturnType<typeof installBridge>;
  let stop: () => void;

  beforeEach(() => {
    agentRows.value = [];
    projectTeams.value = {};
    bridge = installBridge();
    stop = initAppSteering();
  });

  afterEach(() => {
    stop();
    bridge.teardown();
  });

  it("creates an agent with its bot, picture and teams", async () => {
    bridge.emit(
      agentMutation({
        op: "create",
        agentId: "agent-steered",
        fields: {
          name: "Steered",
          bot: { form: "droplet", color: "teal", expression: "curious" },
          avatar: { source: "dicebear", src: "data:image/svg+xml;base64,AAAA" },
        },
        projectPaths: ["/tmp/alpha", "/tmp/beta"],
      }),
    );
    await flushSteering();

    const made = agentById("agent-steered");
    expect(made?.name).toBe("Steered");
    expect(made?.bot).toEqual({ form: "droplet", color: "teal", expression: "curious" });
    expect(made?.avatar).toEqual({ source: "dicebear", src: "data:image/svg+xml;base64,AAAA" });
    expect(projectTeam("/tmp/alpha").map((agent) => agent.id)).toEqual(["agent-steered"]);
    expect(projectTeam("/tmp/beta").map((agent) => agent.id)).toEqual(["agent-steered"]);
  });

  // Without its creature there is nothing to show while it works, so a
  // bot-less create is refused rather than stored bot-less.
  it("refuses a create without a bot", async () => {
    bridge.emit(
      agentMutation({ op: "create", agentId: "agent-botless", fields: { name: "Botless" } }),
    );
    await flushSteering();

    expect(agentById("agent-botless")).toBeUndefined();
    expect(agentRoster().some((agent) => agent.name === "Botless")).toBe(false);
  });

  it("updates a bot and moves the agent between teams", async () => {
    bridge.emit(
      agentMutation({
        op: "create",
        agentId: "agent-mover",
        fields: {
          name: "Mover",
          bot: { form: "circle", color: "ink", expression: "neutral" },
        },
        projectPaths: ["/tmp/alpha"],
      }),
    );
    await flushSteering();
    expect(projectTeam("/tmp/alpha").map((agent) => agent.id)).toEqual(["agent-mover"]);

    bridge.emit(
      agentMutation({
        op: "update",
        agentId: "agent-mover",
        fields: { bot: { form: "hexagon", color: "teal", expression: "curious" } },
        addToTeams: ["/tmp/beta"],
        removeFromTeams: ["/tmp/alpha"],
      }),
    );
    await flushSteering();

    expect(agentById("agent-mover")?.bot).toEqual({
      form: "hexagon",
      color: "teal",
      expression: "curious",
    });
    expect(projectTeam("/tmp/alpha")).toEqual([]);
    expect(projectTeam("/tmp/beta").map((agent) => agent.id)).toEqual(["agent-mover"]);
  });
});

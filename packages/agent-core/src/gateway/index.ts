// The agent-facing MCP gateway (docs/mcp-gateway-design.md).
//
// A loopback streamable-HTTP MCP server embedded in the desktop main process.
// Provider sessions (Claude today, the rest in Phase B) reach it with a
// per-session bearer token minted at startSession; write authority is pinned
// to the exact running turn. It bootstraps with the scratchpad and
// thread-spawning tools — agents read/edit the project scratchpad the web
// board renders, and open, follow and read kone threads — and with the
// app-steering tools: the theme, the agent roster, the reusable sub-agent
// definitions, and the thread strip. Every one of those is a pure registry
// entry on the same server, which is what makes the next surface an agent can
// steer a new tools/ module rather than a new transport.

import type { ConversationStore } from "../ConversationStore.js";
import type { EmitEvent, GatewayConnection, ProviderKind, RuntimeEvent } from "../types.js";
import { GatewayCredentials } from "./credentials.js";
import { startGatewayHttpServer } from "./httpServer.js";
import { makeInFlightRequestRegistry } from "./inFlightRequests.js";
import { makeMcpTransport } from "./mcpTransport.js";
import { createRegistry, type GatewayApprove } from "./registry.js";
import { createScratchpadTools } from "./tools/scratchpad.js";
import { createSpawnTools } from "./tools/spawn.js";
import { createIrcTools } from "./tools/irc.js";
import { createLaunchTools, ProcessSupervisor } from "./tools/launch.js";
import {
  createAppThemeTools,
  type AppearanceReading,
  type AppThemeToolOptions,
  type ThemeRosterEntry,
} from "./tools/appTheme.js";
import {
  createAppAgentTools,
  type AgentRosterEntry,
  type AppAgentToolOptions,
} from "./tools/appAgents.js";
import { createAppSubagentTools } from "./tools/appSubagents.js";
import {
  createAppStripTools,
  type AppStripToolOptions,
  type StripSettingsReading,
} from "./tools/appStrip.js";

export type { GatewaySessionCredential } from "./credentials.js";
export { GatewayCredentials } from "./credentials.js";
export { GatewayToolError } from "./schemas.js";
export type { GatewayApprove, GatewayApprovalRequest } from "./registry.js";

export const GATEWAY_SERVER_VERSION = "0.1.0";

/** The live-turn ledger the gateway learns by listening to the existing
 *  AgentService event stream (turn.started / turn.completed / turn.aborted) —
 *  adapter-agnostic. */
type TurnState = { turnId: string; running: boolean };

export interface GatewayHandle {
  /** Mint (and revoke any prior) session credential for a thread. Called from
   *  AgentService.startSession so the adapter can inject the connection. */
  connectionForThread(threadId: string, provider: ProviderKind, model?: string): GatewayConnection;
  /** Mint a one-shot stdio bootstrap token for one session credential
   *  (Antigravity's secret-free plugin MCP path — see GatewayCredentials).
   *  Null when the session token is no longer live. */
  issueBootstrapToken(sessionToken: string): string | null;
  /** Revoke every credential a thread owns (AgentService.stopSession). */
  revokeThread(threadId: string): void;
  /** The resolved endpoint, valid once the server is listening. */
  readonly mcpEndpointUrl: () => string;
  /** Resolves when the loopback server is accepting connections. */
  readonly ready: Promise<void>;
  /** Stop accepting connections (app quit). */
  shutdown(): Promise<void>;
}

export interface GatewayInput {
  store: ConversationStore;
  /** Events the gateway raises (scratchpad.updated) — the IPC layer broadcasts
   *  these to renderers. */
  emit: EmitEvent;
  /** Subscribe to the AgentService runtime event stream — the gateway watches
   *  turn lifecycle here, adapter-agnostically. */
  onEvents: (listener: (event: RuntimeEvent) => void) => () => void;
  /** Asks the user to approve a `permission: "ask"` tool call. Without one,
   *  every such tool is refused rather than silently allowed. */
  approve?: GatewayApprove;
  /** Whether a thread has a live provider session — what the IRC roster reads
   *  to tell a sender whether a message interrupts a peer or waits for it.
   *  Absent, every peer reads as away, which is the safe way to be wrong. */
  isThreadLive?: (threadId: string) => boolean;
  /** The appearance the renderer last reported, for `app_get_theme_state`.
   *  Absent, the tool reports that the current theme is unknown rather than
   *  naming a default that may not be the one on screen. */
  readAppearance?: () => AppearanceReading | null;
  /** The theme library the renderer last reported. Absent, the theme tools say
   *  the library is unknown rather than offering a list of their own — an
   *  install's themes include whatever the user imported or authored, which
   *  only the renderer can see. */
  readThemes?: () => readonly ThemeRosterEntry[] | null;
  /** The agent roster the renderer last reported. Absent, the roster tools say
   *  the roster is unknown rather than offering one of their own — kone's
   *  shipped agents are prose in the renderer's bundle and a stored row is a
   *  delta against one, so only it can report who the roster actually holds. */
  readAgents?: () => readonly AgentRosterEntry[] | null;
  /** The thread strip settings the renderer last reported. Absent, the strip
   *  tools report them as unknown rather than naming defaults the user may
   *  have changed. */
  readStripSettings?: () => StripSettingsReading | null;
}

export function createGateway(input: GatewayInput): GatewayHandle {
  // Both readers are optional and stay omitted rather than undefined: the theme
  // tools distinguish "the app has not reported this" from "nobody wired a
  // reader", and an explicit undefined would erase that distinction.
  const appThemeOptions: AppThemeToolOptions = { emit: input.emit };
  if (input.readAppearance) appThemeOptions.readAppearance = input.readAppearance;
  if (input.readThemes) appThemeOptions.readThemes = input.readThemes;
  // Same contract for the roster and the strip: an absent reader is a different
  // answer from one that has nothing to report yet, and passing an explicit
  // undefined would erase the difference.
  const appAgentOptions: AppAgentToolOptions = { emit: input.emit };
  if (input.readAgents) appAgentOptions.readAgents = input.readAgents;
  const appStripOptions: AppStripToolOptions = { emit: input.emit };
  if (input.readStripSettings) appStripOptions.readStripSettings = input.readStripSettings;

  const credentials = new GatewayCredentials();
  const inFlight = makeInFlightRequestRegistry();
  const turnState = new Map<string, TurnState>();
  const launchSupervisor = new ProcessSupervisor();
  const tools = [
    ...createScratchpadTools({ store: input.store, emit: input.emit }),
    ...createSpawnTools({ store: input.store }),
    ...createIrcTools(
      input.isThreadLive
        ? { store: input.store, isThreadLive: input.isThreadLive }
        : { store: input.store },
    ),
    ...createLaunchTools({ supervisor: launchSupervisor }),
    ...createAppThemeTools(appThemeOptions),
    ...createAppAgentTools(appAgentOptions),
    ...createAppSubagentTools({ store: input.store, emit: input.emit }),
    ...createAppStripTools(appStripOptions),
  ];
  const registry = createRegistry(tools, { approve: input.approve });
  const transport = makeMcpTransport({
    credentials,
    registry,
    store: input.store,
    turnState,
    serverVersion: GATEWAY_SERVER_VERSION,
    inFlight,
    instructions:
      "kone gateway: tools that read and write the project scratchpad, that " +
      "open, follow and read kone threads, and that steer the app itself — its " +
      "theme, its agent roster, its reusable sub-agent definitions, and its " +
      "thread strip. Scratchpad writes are attributed to the calling agent and " +
      "guarded by a revision shared with the web editor; spawned threads are " +
      "first-class conversations the user can see; agents working the same " +
      "project can message each other, and a message reaches its recipient's " +
      "turn rather than sitting in a mailbox. The app-steering tools act on the " +
      "window the user is looking at, so use them instead of editing files or " +
      "running shell commands to configure kone.",
  });
  const server = startGatewayHttpServer({ credentials, transport });

  // Turn tracking: the authority boundary. A token's write authority is the
  // exact turn running at first write; terminal events retire it.
  const detach = input.onEvents((event) => {
    if (event.type === "turn.started") {
      turnState.set(event.threadId, { turnId: event.turnId, running: true });
      return;
    }
    if (event.type === "turn.completed" || event.type === "turn.aborted") {
      const current = turnState.get(event.threadId);
      if (current?.turnId === event.turnId) {
        turnState.set(event.threadId, { turnId: event.turnId, running: false });
      }
      // Every token this thread owns loses authority for this turn.
      for (const token of credentials.tokensForThread(event.threadId)) {
        credentials.retireSessionTurn(token, event.turnId);
      }
      // The turn event is also the abort path some MCP clients rely on — they
      // omit notifications/cancelled when the parent operation is interrupted —
      // so sweep the turn's in-flight work here. cancelTurn tombstones the turn
      // id, cancelling a request that races Stop the moment it registers.
      void inFlight.cancelTurn(event.threadId, event.turnId).settled;
    }
  });

  void server.ready;

  return {
    // The grant is minted in one place: the credential half from
    // GatewayCredentials, the tool half from the registry that will actually
    // serve the calls. An adapter can then describe the session's tools without
    // knowing a registry exists.
    connectionForThread: (threadId, provider, model) => ({
      ...credentials.connectionForThread(threadId, provider, model),
      tools: registry.listToolPrompts(),
    }),
    issueBootstrapToken: (sessionToken) => credentials.issueStdioBootstrapToken(sessionToken),
    revokeThread: (threadId) => {
      // Revoke in-flight work before dropping the token so an active
      // cancel() still resolves its registration against a live session.
      inFlight.revokeSession(threadId);
      credentials.revokeThread(threadId);
    },
    mcpEndpointUrl: () => credentials.mcpEndpointUrl(),
    ready: server.ready,
    shutdown: async () => {
      detach();
      await launchSupervisor.stopAll();
      await server.close();
    },
  };
}

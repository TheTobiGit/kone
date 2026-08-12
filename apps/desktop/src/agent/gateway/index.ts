// The agent-facing MCP gateway (docs/mcp-gateway-design.md).
//
// A loopback streamable-HTTP MCP server embedded in the desktop main process.
// Provider sessions (Claude today, the rest in Phase B) reach it with a
// per-session bearer token minted at startSession; write authority is pinned
// to the exact running turn. It bootstraps with the scratchpad and
// thread-spawning tools — agents read/edit the project scratchpad the web
// board renders, and open, follow and read kone threads. Future tools (side
// chats, theme, panes) are pure registry entries on the same server.
//
// httpRoute.ts / AgentGatewayCredentials.ts), reimplemented in plain TS.

import type { ConversationStore } from "../ConversationStore.js";
import type { EmitEvent, ProviderKind, RuntimeEvent } from "../types.js";
import { GatewayCredentials, type GatewayConnection } from "./credentials.js";
import { startGatewayHttpServer } from "./httpServer.js";
import { makeMcpTransport } from "./mcpTransport.js";
import { createRegistry } from "./registry.js";
import { createScratchpadTools } from "./tools/scratchpad.js";
import { createSpawnTools } from "./tools/spawn.js";

export type { GatewayConnection } from "./credentials.js";
export { GatewayCredentials } from "./credentials.js";
export { GatewayToolError } from "./schemas.js";

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
}

export function createGateway(input: GatewayInput): GatewayHandle {
  const credentials = new GatewayCredentials();
  const turnState = new Map<string, TurnState>();

  const tools = [
    ...createScratchpadTools({ store: input.store, emit: input.emit }),
    ...createSpawnTools({ store: input.store }),
  ];
  const registry = createRegistry(tools);
  const transport = makeMcpTransport({
    credentials,
    registry,
    store: input.store,
    turnState,
    serverVersion: GATEWAY_SERVER_VERSION,
    instructions:
      "kone gateway: tools that read and write the project scratchpad, and that " +
      "open, follow and read kone threads. Scratchpad writes are attributed to " +
      "the calling agent and guarded by a revision shared with the web editor; " +
      "spawned threads are first-class conversations the user can see.",
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
    }
  });

  void server.ready;

  return {
    connectionForThread: (threadId, provider, model) =>
      credentials.connectionForThread(threadId, provider, model),
    issueBootstrapToken: (sessionToken) => credentials.issueStdioBootstrapToken(sessionToken),
    revokeThread: (threadId) => credentials.revokeThread(threadId),
    mcpEndpointUrl: () => credentials.mcpEndpointUrl(),
    ready: server.ready,
    shutdown: async () => {
      detach();
      await server.close();
    },
  };
}

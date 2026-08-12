// Per-session gateway credentials (docs/mcp-gateway-design.md §4).
//
// Opaque bearer tokens minted at startSession, revoked at stopSession — no
// JWT, no expiry, revocation is a map delete. Write authority is narrower
// than the token: the first write of a turn binds the token to that running
// turn, and retireSessionTurn (fired from turn.completed/aborted) marks the
// binding stale. A stale binding is rebindable: the token outlives the turn,
// so the next turn rebinds to itself — a request racing a turn boundary can
// never borrow a STILL-RUNNING turn's authority, but it may bind to the new
// turn once the old one settles.
//
// a fresh app boot cannot resurrect authority for a dead provider process.

import { randomUUID } from "node:crypto";

import type { ProviderKind } from "../types.js";

export interface GatewayConnection {
  /** Loopback streamable-HTTP MCP endpoint, e.g. `http://127.0.0.1:41231/mcp`. */
  url: string;
  /** Bearer token bound to one provider session. */
  bearerToken: string;
}

export interface GatewaySessionIdentity {
  threadId: string;
  provider: ProviderKind;
  model?: string;
}

export interface GatewayWriteAuthority {
  turnId: string;
  live: boolean;
}

export class GatewayCredentials {
  private readonly tokens = new Map<string, GatewaySessionIdentity>();
  private readonly tokensByThread = new Map<string, Set<string>>();
  private readonly authorities = new Map<string, GatewayWriteAuthority>();
  /** One-shot stdio bootstrap tokens → the session token they resolve to.
   *  Used by providers whose MCP config must be secret-free on disk
   *  (Antigravity's globally-installed plugin mcp_config.json): the CLI's
   *  process env carries only a single-use bootstrap, which the spawned MCP
   *  proxy exchanges at POST /bootstrap for the real session token — so the
   *  session credential never enters the provider process env (or its
   *  exec-tool descendants), and a stolen bootstrap is spent after one use. */
  private readonly bootstrapTokens = new Map<string, string>();

  private port = 0;

  constructor(private readonly baseUrl = "http://127.0.0.1") {}

  /** The endpoint URL — valid once the HTTP server resolved a dynamic port. */
  mcpEndpointUrl(): string {
    return `${this.baseUrl}:${this.port}/mcp`;
  }

  setListeningPort(port: number): void {
    this.port = port;
  }

  /** Mint a new opaque bearer token for one provider session. */
  issueSessionToken(threadId: string, provider: ProviderKind, model?: string): string {
    // A restart of the same thread revokes the old credential outright — a
    // thread owns at most one live gateway session.
    this.revokeThread(threadId);
    const token = `kone_gw_${randomUUID()}`;
    this.tokens.set(token, { threadId, provider, model });
    let set = this.tokensByThread.get(threadId);
    if (!set) {
      set = new Set();
      this.tokensByThread.set(threadId, set);
    }
    set.add(token);
    return token;
  }

  /** Resolve a live token to its session, or null. */
  verifySessionToken(token: string): GatewaySessionIdentity | null {
    return this.tokens.get(token) ?? null;
  }

  /** Mint the endpoint + token bundle for one session start. */
  connectionForThread(
    threadId: string,
    provider: ProviderKind,
    model?: string,
  ): GatewayConnection {
    return {
      url: this.mcpEndpointUrl(),
      bearerToken: this.issueSessionToken(threadId, provider, model),
    };
  }

  /** Pin the token to the turn running when the request arrives. A binding to
   *  a still-LIVE different turn is refused, so a request racing a turn
   *  boundary can never borrow the running turn's authority. A binding to a
   *  SETTLED turn (retired on turn.completed/aborted) is stale, not fatal: the
   *  token outlives the turn, so the next turn rebinds to it — otherwise a
   *  session could write only during its very first turn. */
  bindWriteAuthority(token: string, turnId: string): boolean {
    const authority = this.authorities.get(token);
    if (authority) {
      if (authority.turnId === turnId) return authority.live;
      if (authority.live) return false;
      authority.turnId = turnId;
      authority.live = true;
      return true;
    }
    this.authorities.set(token, { turnId, live: true });
    return true;
  }

  /** The token's bound turn, or null when it holds no live write authority. */
  verifyWriteAuthority(token: string): { turnId: string } | null {
    const authority = this.authorities.get(token);
    return authority && authority.live ? { turnId: authority.turnId } : null;
  }

  /** Tombstone the token's authority for one terminal turn. Synchronous: a
   *  request racing the terminal event can no longer bind this token. */
  retireSessionTurn(token: string, turnId: string): void {
    const authority = this.authorities.get(token);
    if (authority && authority.turnId === turnId) authority.live = false;
  }

  /** Revoke exactly one token (stopSession). */
  revokeSessionToken(token: string): void {
    this.tokens.delete(token);
    this.authorities.delete(token);
    // Any bootstrap minted against a revoked session is dead too — a turn
    // racing the stop must not exchange its way into a ghost credential.
    for (const [bootstrap, sessionToken] of [...this.bootstrapTokens]) {
      if (sessionToken === token) this.bootstrapTokens.delete(bootstrap);
    }
  }

  /** Revoke every credential a thread owns. */
  revokeThread(threadId: string): void {
    const tokens = this.tokensByThread.get(threadId);
    if (!tokens) return;
    for (const token of tokens) this.revokeSessionToken(token);
    this.tokensByThread.delete(threadId);
  }

  /** The live tokens a thread owns — used to retire write authority when a
   *  turn settles. */
  tokensForThread(threadId: string): string[] {
    return [...(this.tokensByThread.get(threadId) ?? [])];
  }

  /** Mint a one-shot bootstrap token for one session token. The bootstrap is
   *  single-use (exchangeStdioBootstrapToken deletes it) and short-lived by
   *  construction: each Antigravity print turn is a fresh process that needs
   *  exactly one exchange, so the token dies with the turn even if it leaks.
   *  Null when the session token is no longer live. */
  issueStdioBootstrapToken(sessionToken: string): string | null {
    if (!this.tokens.has(sessionToken)) return null;
    const bootstrap = `kone_boot_${randomUUID()}`;
    this.bootstrapTokens.set(bootstrap, sessionToken);
    return bootstrap;
  }

  /** Redeem a bootstrap token for its session token. Single-use: the mapping
   *  is deleted on the first successful exchange, so a reused or stolen
   *  bootstrap cannot mint a second credential. */
  exchangeStdioBootstrapToken(bootstrap: string): string | null {
    const sessionToken = this.bootstrapTokens.get(bootstrap);
    if (sessionToken === undefined) return null;
    this.bootstrapTokens.delete(bootstrap);
    return this.tokens.has(sessionToken) ? sessionToken : null;
  }
}

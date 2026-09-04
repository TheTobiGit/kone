import { AntigravityAcpAdapter, type AntigravityRpcFactory } from "./AntigravityAcpAdapter.js";
import { AntigravityPrintAdapter } from "./AntigravityPrintAdapter.js";
import type { AntigravityAcpResolvedBinary } from "../antigravityAcpBinary.js";
import type {
  AdapterCapabilities,
  ApprovalDecision,
  EmitEvent,
  ModelDescriptor,
  ProviderAdapter,
  ProviderConfig,
  ProviderKind,
  ProviderStatus,
  Session,
  SendTurnInput,
  SessionStartInput,
  TurnStartResult,
  UserInputAnswers,
} from "../types.js";

// Antigravity facade — one ProviderAdapter for the "antigravity" provider that
// serves ACP when the server resolves and print mode otherwise.
//
// ACP (AntigravityAcpAdapter) is the primary transport: a real session with
// streaming, approvals, cancel and resume. Print mode
// (AntigravityPrintAdapter, the `agy -p` adapter this facade replaces as the
// registered provider) stays as the fallback for machines with no ACP server —
// no managed runtime, no override, nothing on PATH. The fallback is
// availability-routed, never error-routed: an ACP session that fails for a
// real reason (auth, protocol) surfaces that error instead of silently
// reopening the thread on a different transport with a blank conversation.
// The one exception is a vanishing binary — an ACP start that fails because
// the server is no longer there retries once on print, since the availability
// check passed moments earlier.
//
// Per-thread transport is pinned at startSession: a thread that opened on ACP
// keeps ACP for its lifetime (and vice versa), so a mid-thread install or
// uninstall can't split one conversation across two transports.

type AntigravityTransport = "acp" | "print";

export type AntigravityAdapterOptions = {
  /** Print-mode plugin dir root — the real home in production; tests point
   *  this at a temp dir so the machine's ~/.gemini is never touched. */
  homeDir?: string;
  /** Inject the ACP binary resolution (tests point it at a fake transport). */
  resolveBinary?: () => AntigravityAcpResolvedBinary | null;
  /** User-data dir for managed-runtime resolution. Defaults to the app's. */
  userDataDir?: string;
  /** ACP transport factory — production spawns the real server child; tests
   *  inject a scripted fake. */
  createRpc?: AntigravityRpcFactory;
};

export class AntigravityAdapter implements ProviderAdapter {
  readonly provider: ProviderKind = "antigravity";
  readonly capabilities: AdapterCapabilities = {
    // The primary transport applies model/mode switches on the live session.
    sessionModelSwitch: "in-session",
    streamsText: true,
    supportsToolEvents: true,
    supportsResume: true,
    supportsModelList: true,
    // ACP reports subagent invocations as ordinary tool calls; the print
    // fallback tracks native runs, but the facade advertises the primary.
    supportsSubagents: false,
  };

  private readonly print: AntigravityPrintAdapter;
  private readonly acp: AntigravityAcpAdapter;
  private readonly transports = new Map<string, AntigravityTransport>();

  constructor(
    emit: EmitEvent,
    issueBootstrapToken?: (sessionToken: string) => string | null,
    options: AntigravityAdapterOptions = {},
  ) {
    this.print = new AntigravityPrintAdapter(emit, issueBootstrapToken, {
      homeDir: options.homeDir,
    });
    this.acp = new AntigravityAcpAdapter(emit, {
      userDataDir: options?.userDataDir,
      resolveBinary: options?.resolveBinary,
      createRpc: options?.createRpc,
    });
  }

  /** True when the ACP server resolves — the primary transport. Public so
   *  AgentService can answer the spawn guard's mode-floor question: an
   *  Antigravity child may run below full-access only when ACP serves it. */
  acpAvailable(): boolean {
    return this.acp.resolveBinary() !== null;
  }

  setConfig(config: ProviderConfig): void {
    this.print.setConfig?.(config);
    this.acp.setConfig(config);
  }

  // ── discovery ─────────────────────────────────────────────────────────────

  async discover(): Promise<ProviderStatus> {
    return this.acpAvailable() ? this.acp.discover() : this.print.discover();
  }

  async listModels(): Promise<ModelDescriptor[]> {
    return this.acpAvailable() ? this.acp.listModels() : this.print.listModels();
  }

  // ── lifecycle (request/ack — results flow through agent:event) ─────────────

  async startSession(input: SessionStartInput): Promise<Session> {
    if (!this.acpAvailable()) {
      this.transports.set(input.threadId, "print");
      return this.print.startSession(input);
    }
    try {
      const session = await this.acp.startSession(input);
      this.transports.set(input.threadId, "acp");
      return session;
    } catch (error) {
      // The binary vanished between the availability check and the spawn, or
      // the spawn itself found nothing to execute — retry once on print
      // rather than failing a thread the fallback could have opened.
      if (!isMissingBinaryError(error) && this.acp.resolveBinary() !== null) throw error;
      console.warn(
        "[antigravity] ACP server unavailable at session start, falling back to print mode:",
        error instanceof Error ? error.message : String(error),
      );
      this.transports.set(input.threadId, "print");
      return this.print.startSession(input);
    }
  }

  async sendTurn(input: SendTurnInput): Promise<TurnStartResult> {
    return this.transportFor(input.threadId).sendTurn(input);
  }

  async interruptTurn(threadId: string): Promise<void> {
    return this.transportFor(threadId).interruptTurn(threadId);
  }

  async stopSession(threadId: string): Promise<void> {
    const transport = this.transports.get(threadId);
    this.transports.delete(threadId);
    if (transport === "acp") return this.acp.stopSession(threadId);
    if (transport === "print") return this.print.stopSession(threadId);
    // Unknown thread — stop on both; each no-ops when it owns nothing.
    await this.acp.stopSession(threadId);
    await this.print.stopSession(threadId);
  }

  async stopAll(): Promise<void> {
    this.transports.clear();
    await Promise.all([this.acp.stopAll(), this.print.stopAll()]);
  }

  async respondToRequest(threadId: string, requestId: string, decision: ApprovalDecision): Promise<void> {
    return this.transportFor(threadId).respondToRequest(threadId, requestId, decision);
  }

  async respondToUserInput(threadId: string, requestId: string, answers: UserInputAnswers): Promise<void> {
    return this.transportFor(threadId).respondToUserInput(threadId, requestId, answers);
  }

  async listSessions(): Promise<Session[]> {
    const [acpSessions, printSessions] = await Promise.all([
      this.acp.listSessions(),
      this.print.listSessions(),
    ]);
    return [...acpSessions, ...printSessions];
  }

  async hasSession(threadId: string): Promise<boolean> {
    if (this.transports.has(threadId)) return true;
    return (await this.acp.hasSession(threadId)) || (await this.print.hasSession(threadId));
  }

  private transportFor(threadId: string): AntigravityAcpAdapter | AntigravityPrintAdapter {
    const transport = this.transports.get(threadId);
    if (transport === "print") return this.print;
    if (transport === "acp") return this.acp;
    // No session yet (or a session from before this facade owned the thread):
    // route by current availability. Both adapters throw a clear "no session"
    // when the thread isn't theirs.
    return this.acpAvailable() ? this.acp : this.print;
  }
}

/** True when an ACP start failed because there is no server to spawn — our
 *  own missing-binary error, or the OS reporting ENOENT on the spawn. Any
 *  other failure (auth, protocol) belongs to the caller, not the fallback. */
function isMissingBinaryError(cause: unknown): boolean {
  const message = cause instanceof Error ? cause.message : String(cause);
  if (message.includes("ACP server not found")) return true;
  if (!(cause instanceof Object) || Array.isArray(cause)) return false;
  // SAFETY: cause is verified as a non-array Object record; code is read
  // defensively and only compared, never trusted as a shape.
  const record = cause as { code?: unknown };
  const code = record.code;
  return code !== null && code !== undefined && !(code instanceof Object) && String(code) === "ENOENT";
}

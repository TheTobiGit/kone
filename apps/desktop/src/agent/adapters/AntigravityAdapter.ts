import { readdir, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { buildAgentEnv } from "../processEnv.js";
import { probe, runStreaming, type StreamingRun } from "../spawn.js";
import type {
  AdapterCapabilities,
  ApprovalDecision,
  EmitEvent,
  InteractionMode,
  ModelDescriptor,
  ProviderAdapter,
  ProviderStatus,
  RuntimeItem,
  Session,
  SendTurnInput,
  SessionStartInput,
  TurnStartResult,
} from "../types.js";

// Adapter for Google Antigravity via its `agy` CLI (v1.1.x).
//
// Transport reality (established by probing the installed CLI): `agy` has no
// ACP, no JSON-RPC, and no structured/stream output. The only headless surface
// is print mode — `agy -p "<prompt>"` runs one prompt and prints the assistant's
// text answer to stdout (buffered, not token-streamed). So a "session" here is a
// logical thread mapped onto an `agy` *conversation*, and each turn is one
// `agy -p` invocation, resumed with `--conversation <id>`.
//
// Two rough edges we handle deliberately:
//  1. print mode can exit non-zero and print `Error: timeout waiting for
//     response` on stderr *even when it already produced the real answer on
//     stdout*. We treat "stdout has content" as success regardless of exit code.
//  2. the conversation id `agy` assigns is not printed anywhere. It is persisted
//     as ~/.gemini/antigravity-cli/conversations/<id>.db, so we capture the
//     newest .db written during the turn and store it for resume.
//
// Auth is pure "bring your own subscription": the CLI reads the user's own
// Google Sign-In OAuth from ~/.gemini/oauth_creds.json (or an API-key env var).
// We only detect it; we never store or forward a token.

const BINARY = "agy";
const GEMINI_HOME = path.join(os.homedir(), ".gemini");
const OAUTH_CREDS = path.join(GEMINI_HOME, "oauth_creds.json");
const CONVERSATIONS_DIR = path.join(GEMINI_HOME, "antigravity-cli", "conversations");

type SessionEntry = {
  session: Session;
  /** The turn currently in flight, so interrupt can reach it. */
  run: StreamingRun | null;
};

export class AntigravityAdapter implements ProviderAdapter {
  readonly provider = "antigravity" as const;

  readonly capabilities: AdapterCapabilities = {
    // print mode is stateless per invocation; a model change just changes the
    // next `--model` flag — no session to restart.
    sessionModelSwitch: "in-session",
    // buffered stdout, not token deltas — we emit one assistant_text item that
    // fills line-by-line as agy flushes, but it typically arrives at once.
    streamsText: true,
    // no structured tool events over print mode.
    supportsToolEvents: false,
    supportsResume: true,
    supportsModelList: true,
  };

  private readonly sessions = new Map<string, SessionEntry>();

  constructor(private readonly emit: EmitEvent) {}

  // ── discovery / health ─────────────────────────────────────────────────────

  async discover(): Promise<ProviderStatus> {
    const env = await buildAgentEnv();
    const versionOut = await probe(BINARY, ["--version"], env, 10_000);

    if (versionOut === null) {
      return {
        provider: this.provider,
        label: "Antigravity",
        available: false,
        authStatus: "unknown",
        readiness: "not-installed",
        message: "Antigravity CLI (`agy`) is not installed or not on PATH.",
      };
    }

    const version = versionOut.trim().split("\n")[0]?.trim() || undefined;
    const auth = await this.detectAuth(env);

    return {
      provider: this.provider,
      label: "Antigravity",
      available: true,
      version,
      authStatus: auth.status,
      authLabel: auth.label,
      readiness: auth.status === "authenticated" ? "ready" : "needs-login",
      message:
        auth.status === "authenticated"
          ? undefined
          : "Run `agy` and sign in with Google to use your Antigravity subscription.",
    };
  }

  /** Auth precedence: an explicit API key env var, else a fresh Google Sign-In
   *  OAuth token on disk. Read-only — we inspect, never write. */
  private async detectAuth(
    env: NodeJS.ProcessEnv,
  ): Promise<{ status: "authenticated" | "unauthenticated"; label?: string }> {
    if (env.ANTIGRAVITY_API_KEY || env.GEMINI_API_KEY) {
      return { status: "authenticated", label: "Antigravity API Key" };
    }
    try {
      const raw = await readFile(OAUTH_CREDS, "utf8");
      const creds = JSON.parse(raw) as {
        access_token?: string;
        refresh_token?: string;
        expiry_date?: number;
      };
      const hasToken = Boolean(creds.access_token || creds.refresh_token);
      const stillValid =
        typeof creds.expiry_date !== "number" ||
        creds.expiry_date > Date.now() ||
        Boolean(creds.refresh_token);
      if (hasToken && stillValid) {
        return { status: "authenticated", label: "Google Sign-In" };
      }
    } catch {
      // No creds file / unreadable ⇒ not logged in.
    }
    return { status: "unauthenticated" };
  }

  async listModels(): Promise<ModelDescriptor[]> {
    const env = await buildAgentEnv();
    const out = await probe(BINARY, ["models"], env, 20_000);
    if (out === null) return [];
    return out
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((label) => ({ id: label, label }));
  }

  // ── lifecycle ───────────────────────────────────────────────────────────────

  async startSession(input: SessionStartInput): Promise<Session> {
    const session: Session = {
      threadId: input.threadId,
      provider: this.provider,
      cwd: input.cwd,
      status: "ready",
      model: input.model,
      mode: input.mode ?? "default",
    };
    this.sessions.set(input.threadId, { session, run: null });

    this.publish(input.threadId, { type: "session.started" }, "antigravity.print.lifecycle");
    this.publish(
      input.threadId,
      { type: "session.state.changed", state: "ready" },
      "antigravity.print.lifecycle",
    );
    return session;
  }

  async sendTurn(input: SendTurnInput): Promise<TurnStartResult> {
    const entry = this.sessions.get(input.threadId);
    if (!entry) throw new Error(`No agent session for thread ${input.threadId}`);
    if (entry.run) throw new Error("A turn is already running on this thread");

    const turnId = randomUUID();
    const { session } = entry;
    session.activeTurnId = turnId;
    session.status = "running";
    const model = input.model ?? session.model;
    const mode = input.mode ?? session.mode;

    this.publish(
      input.threadId,
      { type: "session.state.changed", state: "running" },
      "antigravity.print.lifecycle",
    );
    this.publish(input.threadId, { type: "turn.started", turnId }, "antigravity.print.lifecycle");

    // One assistant_text item fills as stdout arrives.
    const item: RuntimeItem = {
      itemId: randomUUID(),
      kind: "assistant_text",
      status: "in-progress",
      text: "",
    };
    this.publish(
      input.threadId,
      { type: "item.started", turnId, item: { ...item } },
      "antigravity.print.lifecycle",
    );

    const env = await buildAgentEnv();
    const args = this.buildTurnArgs(session.conversationId, model, mode, input.input);

    // Snapshot conversation ids before the run so we can spot the one this turn
    // writes (agy never prints it).
    const before = await this.readConversations();
    const startedAt = Date.now();

    const run = runStreaming(BINARY, args, {
      cwd: session.cwd,
      env,
      onStdoutLine: (line) => {
        item.text += item.text ? `\n${line}` : line;
        this.publish(
          input.threadId,
          { type: "item.updated", turnId, item: { ...item } },
          "antigravity.print.stdout",
        );
      },
    });
    entry.run = run;

    // Drive completion without blocking the ack: sendTurn resolves now; the
    // result flows through the event stream.
    void run.done.then(async (result) => {
      entry.run = null;
      session.activeTurnId = undefined;

      const produced = result.stdout.trim().length > 0;
      const conversationId =
        (await this.captureConversationId(before, startedAt)) ?? session.conversationId;
      if (conversationId) session.conversationId = conversationId;

      if (produced) {
        item.status = "completed";
        this.publish(
          input.threadId,
          { type: "item.completed", turnId, item: { ...item } },
          "antigravity.print.lifecycle",
        );
        session.status = "ready";
        this.publish(
          input.threadId,
          { type: "turn.completed", turnId, conversationId, refs: { conversationId } },
          "antigravity.print.lifecycle",
        );
        this.publish(
          input.threadId,
          { type: "session.state.changed", state: "ready" },
          "antigravity.print.lifecycle",
        );
      } else {
        // No answer on stdout — a genuine failure (bad auth, spawn error, …).
        item.status = "failed";
        this.publish(
          input.threadId,
          { type: "item.completed", turnId, item: { ...item } },
          "antigravity.print.lifecycle",
        );
        session.status = "error";
        const message = lastLine(result.stderr) || `agy exited with code ${result.code}`;
        this.publish(
          input.threadId,
          { type: "turn.aborted", turnId, reason: "failed", message },
          "antigravity.print.stderr",
        );
        this.publish(
          input.threadId,
          { type: "session.state.changed", state: "error", message },
          "antigravity.print.lifecycle",
        );
      }
    });

    return { threadId: input.threadId, turnId };
  }

  private buildTurnArgs(
    conversationId: string | undefined,
    model: string | undefined,
    mode: InteractionMode,
    prompt: string,
  ): string[] {
    const args: string[] = [];
    if (conversationId) args.push("--conversation", conversationId);
    if (model) args.push("--model", model);
    if (mode === "plan") args.push("--mode", "plan");
    else if (mode === "accept-edits") args.push("--mode", "accept-edits");
    else if (mode === "full-access") args.push("--dangerously-skip-permissions");
    args.push("-p", prompt);
    return args;
  }

  async interruptTurn(threadId: string): Promise<void> {
    const entry = this.sessions.get(threadId);
    if (!entry?.run) return;
    const turnId = entry.session.activeTurnId ?? "";
    entry.run.kill();
    entry.run = null;
    entry.session.activeTurnId = undefined;
    entry.session.status = "ready";
    this.publish(
      threadId,
      { type: "turn.aborted", turnId, reason: "interrupted" },
      "antigravity.print.lifecycle",
    );
    this.publish(
      threadId,
      { type: "session.state.changed", state: "ready" },
      "antigravity.print.lifecycle",
    );
  }

  async stopSession(threadId: string): Promise<void> {
    const entry = this.sessions.get(threadId);
    if (!entry) return;
    entry.run?.kill();
    this.sessions.delete(threadId);
    this.publish(
      threadId,
      { type: "session.state.changed", state: "stopped" },
      "antigravity.print.lifecycle",
    );
  }

  async stopAll(): Promise<void> {
    for (const threadId of [...this.sessions.keys()]) {
      await this.stopSession(threadId);
    }
  }

  async respondToRequest(
    _threadId: string,
    _requestId: string,
    _decision: ApprovalDecision,
  ): Promise<void> {
    // Print mode doesn't surface inline approvals — auto-approval is chosen up
    // front via interaction mode. No-op until a richer transport lands.
  }

  async listSessions(): Promise<Session[]> {
    return [...this.sessions.values()].map((e) => ({ ...e.session }));
  }

  async hasSession(threadId: string): Promise<boolean> {
    return this.sessions.has(threadId);
  }

  // ── conversation-id capture (agy never prints it) ───────────────────────────

  private async readConversations(): Promise<Map<string, number>> {
    const map = new Map<string, number>();
    try {
      const entries = await readdir(CONVERSATIONS_DIR);
      for (const name of entries) {
        if (!name.endsWith(".db")) continue;
        const id = name.slice(0, -".db".length);
        try {
          const info = await stat(path.join(CONVERSATIONS_DIR, name));
          map.set(id, info.mtimeMs);
        } catch {
          // Vanished between readdir and stat — skip.
        }
      }
    } catch {
      // Dir doesn't exist yet (no conversations) — empty map.
    }
    return map;
  }

  /** The conversation touched by this turn: a newly-appeared .db, else the one
   *  whose mtime advanced past the turn's start. Null if nothing changed. */
  private async captureConversationId(
    before: Map<string, number>,
    startedAt: number,
  ): Promise<string | null> {
    const after = await this.readConversations();
    let best: { id: string; mtime: number } | null = null;
    for (const [id, mtime] of after) {
      const prior = before.get(id);
      const changed = prior === undefined || mtime > prior;
      if (changed && mtime >= startedAt - 2_000) {
        if (!best || mtime > best.mtime) best = { id, mtime };
      }
    }
    return best?.id ?? null;
  }

  // ── event helper ─────────────────────────────────────────────────────────────

  private publish(
    threadId: string,
    event: Record<string, unknown> & { type: string },
    source: "antigravity.print.stdout" | "antigravity.print.stderr" | "antigravity.print.lifecycle",
  ): void {
    this.emit({
      threadId,
      provider: this.provider,
      at: Date.now(),
      source,
      // The union is validated at the type layer where publish is called with a
      // concrete event shape; this cast keeps the helper generic.
      ...event,
    } as never);
  }
}

/** Last non-empty line of a stream — the part worth surfacing as an error. */
function lastLine(text: string): string {
  return text.trim().split("\n").pop()?.trim() ?? "";
}

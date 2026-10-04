// The cancel probe: does a provider keep a finished tool result when its turn
// is cancelled? kone steer (docs/agent-delivery-design.md §7, §11) interrupts a
// turn right after a tool call completes and delivers a message as the next
// turn, which is only safe when the model still sees what that tool returned.
//
// Run by hand, never in CI. It spends real model tokens on the user's own
// subscriptions:
//
//   bun scripts/cancelProbe.ts                       # every provider, 5 runs each
//   bun scripts/cancelProbe.ts cursor cline          # just these
//   PROBE_RUNS=1 bun scripts/cancelProbe.ts cline    # a quick smoke run
//   PROBE_MODEL_CURSOR=… PROBE_MODEL_CLINE=…         # override a provider's model
//   PROBE_CONTROL=1 bun scripts/cancelProbe.ts cline # the same runs, never cancelled
//
// The control runs tell "the cancel lost the result" apart from "resume loses
// the conversation anyway": they let the turn finish (`sleep 1`) and then ask
// and resume exactly like a probe run.
//
// Each run, in a throwaway directory under the system temp dir:
//   1. writes a file holding a random nonce;
//   2. asks the agent to read it with its file tool, then run `sleep 60`;
//   3. on the read's `item.completed`, deletes the file (so a later answer can
//      only come from the transcript) and interrupts the turn;
//   4. checks the turn really ended as `turn.aborted`; a turn that finished on
//      its own, or an interrupt the provider refused, is `not-cancelled` and
//      proves nothing;
//   5. live runs ask straight away, without tools, what the nonce was. Resume
//      runs first stop the session and reopen it from its conversation id, so
//      the question is the first time the nonce is asked for: an earlier
//      answer would put it back into the conversation.
//
// Each provider gets PROBE_RUNS live runs and as many resume runs.
//
// Every wait has a timeout: a provider that never settles is recorded as
// `hung` and the run moves on. Results print as a table and land as JSON in
// the temp dir.

import { plugin } from "bun";
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { EmitEvent, ProviderAdapter, ProviderKind, RuntimeEvent, SessionStartInput } from "../src/types.ts";

// The stores import `node:sqlite`, which this runtime does not have; its
// `bun:sqlite` driver covers the same surface the stores use.
plugin({
  name: "sqlite-seam",
  setup(build) {
    build.onLoad({ filter: /src\/sqlite\.ts$/ }, () => ({
      contents: 'export { Database as DatabaseSync } from "bun:sqlite";',
      loader: "ts",
    }));
  },
});

// Throwaway directories go under /tmp, never anywhere a project lives.
const tmpdir = (): string => "/tmp";

const realUserData = path.join(homedir(), "Library", "Application Support", "desktop");
// A scratch user-data dir, so the probe's threads never land in the user's
// conversation store. The provider settings and model cache are copied in so
// the service sees the same enabled providers and catalogs the app does.
const probeUserData = mkdtempSync(path.join(tmpdir(), "kone-cancel-probe-data-"));
for (const file of ["provider-settings.json", "provider-cache.json"]) {
  const from = path.join(realUserData, file);
  if (existsSync(from)) copyFileSync(from, path.join(probeUserData, file));
}

const { setUserDataDir } = await import("../src/userDataDir.ts");
setUserDataDir(probeUserData);
const { AgentService } = await import("../src/AgentService.ts");
const { CursorAdapter } = await import("../src/adapters/CursorAdapter.ts");
const { ClineAdapter } = await import("../src/adapters/ClineAdapter.ts");
const { DroidAdapter } = await import("../src/adapters/DroidAdapter.ts");
const { AntigravityAcpAdapter } = await import("../src/adapters/AntigravityAcpAdapter.ts");
const { AntigravityPrintAdapter } = await import("../src/adapters/AntigravityPrintAdapter.ts");
const { isProviderEnabled, readProviderSettings } = await import("../src/providerSettings.ts");
type AgentServiceInstance = InstanceType<typeof AgentService>;

const RUNS = Number(process.env.PROBE_RUNS ?? 5);
const CONTROL = process.env.PROBE_CONTROL === "1";
const START_TIMEOUT_MS = 90_000;
const READ_TIMEOUT_MS = 180_000;
const SETTLE_TIMEOUT_MS = 45_000;
const ANSWER_TIMEOUT_MS = 180_000;
const STOP_TIMEOUT_MS = 20_000;

type Target = {
  /** The probe's own name: Antigravity has two transports under one provider. */
  id: string;
  provider: ProviderKind;
  model: string;
  /** Print mode bakes effort into the CLI's model label, and the bare label is refused. */
  effort?: string;
  make: (emit: EmitEvent) => ProviderAdapter;
};

const TARGETS: Target[] = [
  {
    id: "cursor",
    provider: "cursor",
    model: process.env.PROBE_MODEL_CURSOR ?? "gpt-5.4-mini",
    make: (emit) => new CursorAdapter(emit),
  },
  {
    id: "droid",
    provider: "droid",
    model: process.env.PROBE_MODEL_DROID ?? "",
    make: (emit) => new DroidAdapter(emit),
  },
  {
    id: "cline",
    provider: "cline",
    model: process.env.PROBE_MODEL_CLINE ?? "cline-free/deepseek-v4.1-flash",
    make: (emit) => new ClineAdapter(emit),
  },
  {
    id: "antigravity-acp",
    provider: "antigravity",
    model: process.env.PROBE_MODEL_ANTIGRAVITY_ACP ?? "",
    // The managed ACP runtime is installed under the app's real data dir.
    make: (emit) => new AntigravityAcpAdapter(emit, { userDataDir: realUserData }),
  },
  {
    id: "antigravity-print",
    provider: "antigravity",
    model: process.env.PROBE_MODEL_ANTIGRAVITY_PRINT ?? "Gemini 3.8 Flash",
    effort: "low",
    make: (emit) => new AntigravityPrintAdapter(emit),
  },
];

type Answer = {
  outcome: "pass" | "fail" | "hung" | "error";
  text: string;
  toolCalls: string[];
  detail?: string;
};

type RunResult = {
  run: number;
  mode: "live" | "resume";
  nonce: string;
  outcome: "pass" | "fail" | "hung" | "no-read" | "not-cancelled" | "error";
  detail?: string;
  readTool?: string;
  /** Whether the read's own result, as kone saw it, held the nonce. */
  readSawNonce?: boolean;
  /** How the interrupted turn ended: `turn.aborted`, `turn.completed`, or `hung`. */
  interruptSettle?: string;
  /** Whether the `sleep` tool call had started before the interrupt landed. */
  sleepStarted?: boolean;
  answer?: Answer;
  /** The conversation the reopened session adopted; absent means it came up blank. */
  resumedFrom?: string;
  /** The thread's events in short form, kept when a run did not pass. */
  trace?: string[];
};

type TargetResult = {
  id: string;
  model: string;
  status: "ran" | "unavailable" | "disabled";
  detail?: string;
  runs: RunResult[];
};

class Timeout extends Error {}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Timeout(`${what} timed out after ${ms} ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Every event the service emits for one thread, with waiters on top. */
class ThreadLog {
  readonly events: RuntimeEvent[] = [];
  private waiters: Array<{ match: (e: RuntimeEvent) => boolean; resolve: (e: RuntimeEvent) => void }> = [];

  push(event: RuntimeEvent): void {
    this.events.push(event);
    this.waiters = this.waiters.filter((w) => {
      if (!w.match(event)) return true;
      w.resolve(event);
      return false;
    });
  }

  /** The next event from `from` on that matches, already logged or yet to come. */
  waitFor(match: (e: RuntimeEvent) => boolean, from: number, ms: number, what: string): Promise<RuntimeEvent> {
    const seen = this.events.slice(from).find(match);
    if (seen) return Promise.resolve(seen);
    return withTimeout(new Promise<RuntimeEvent>((resolve) => this.waiters.push({ match, resolve })), ms, what);
  }
}

function isTurnEnd(e: RuntimeEvent): boolean {
  return e.type === "turn.completed" || e.type === "turn.aborted";
}

function itemSummary(e: RuntimeEvent): string {
  if (e.type !== "item.started" && e.type !== "item.completed") return "";
  return [e.item.name, e.item.text, e.item.detail].filter(Boolean).join(" ");
}

/** The assistant text of the events in `[from, to)`: each text item's last snapshot. */
function assistantText(log: ThreadLog, from: number, to: number): string {
  const byItem = new Map<string, string>();
  for (const e of log.events.slice(from, to)) {
    if ((e.type === "item.updated" || e.type === "item.completed") && e.item.kind === "assistant_text") {
      byItem.set(e.item.itemId, e.item.text);
    }
  }
  return [...byItem.values()].join("\n").trim();
}

function traceOf(log: ThreadLog): string[] {
  return log.events
    .filter((e) => e.type !== "item.updated" && e.type !== "thread.token-usage.updated")
    .map((e) => {
      if (e.type === "item.started" || e.type === "item.completed") {
        return `${e.type} ${e.item.kind} ${itemSummary(e).slice(0, 120)}`;
      }
      if (e.type === "turn.aborted") return `${e.type} ${e.reason} ${e.message ?? ""}`;
      if (e.type === "session.state.changed") return `${e.type} ${e.state} ${e.message ?? ""}`;
      if (e.type === "session.warning") return `${e.type} ${e.message}`;
      return e.type;
    });
}

async function ask(
  service: AgentServiceInstance,
  log: ThreadLog,
  threadId: string,
  input: string,
  nonce: string,
): Promise<Answer> {
  const from = log.events.length;
  try {
    await withTimeout(service.sendTurn({ threadId, input }), START_TIMEOUT_MS, "sendTurn");
    const end = await log.waitFor(isTurnEnd, from, ANSWER_TIMEOUT_MS, "answer turn");
    const to = log.events.indexOf(end) + 1;
    const text = assistantText(log, from, to);
    const toolCalls = log.events
      .slice(from, to)
      .filter((e) => e.type === "item.started" && e.item.kind === "tool_call")
      .map(itemSummary);
    const detail = end.type === "turn.aborted" ? `aborted: ${end.reason} ${end.message ?? ""}`.trim() : end.type;
    return { outcome: text.includes(nonce) ? "pass" : "fail", text, toolCalls, detail };
  } catch (error) {
    const text = assistantText(log, from, log.events.length);
    if (error instanceof Timeout) return { outcome: "hung", text, toolCalls: [], detail: error.message };
    return { outcome: "error", text, toolCalls: [], detail: String(error) };
  }
}

async function stopQuietly(service: AgentServiceInstance, threadId: string): Promise<void> {
  await withTimeout(service.stopSession(threadId), STOP_TIMEOUT_MS, "stopSession").catch(() => {});
}

async function probeRun(
  service: AgentServiceInstance,
  logs: Map<string, ThreadLog>,
  target: Target,
  run: number,
  mode: RunResult["mode"],
): Promise<RunResult> {
  const nonce = `kp${randomBytes(5).toString("hex")}`;
  const cwd = mkdtempSync(path.join(tmpdir(), `kone-cancel-probe-${target.id}-`));
  const fileName = "probe-note.txt";
  const filePath = path.join(cwd, fileName);
  writeFileSync(filePath, `The nonce is ${nonce}.\n`);
  const threadId = `cancel-probe-${target.id}-${mode}-${run}-${randomBytes(3).toString("hex")}`;
  const log = new ThreadLog();
  logs.set(threadId, log);
  const result: RunResult = { run, mode, nonce, outcome: "error" };
  const start: SessionStartInput = { threadId, provider: target.provider, cwd, mode: "full-access" };
  if (target.model) start.model = target.model;
  if (target.effort) start.effort = target.effort;
  let conversationId: string | undefined;

  try {
    const session = await withTimeout(service.startSession(start), START_TIMEOUT_MS, "startSession");
    conversationId = session.conversationId;

    const from = log.events.length;
    await withTimeout(
      service.sendTurn({
        threadId,
        input: `Read ${filePath} with your file tool, then run \`sleep ${CONTROL ? 1 : 60}\`.`,
      }),
      START_TIMEOUT_MS,
      "sendTurn",
    );
    const isRead = (e: RuntimeEvent): boolean =>
      e.type === "item.completed" &&
      e.item.kind === "tool_call" &&
      // A long path can be cut short in the summary, so a read-named tool
      // counts too.
      (itemSummary(e).includes(fileName) || /read|view|cat\b/i.test(e.item.name ?? "")) &&
      !itemSummary(e).includes("sleep");
    let first: RuntimeEvent;
    try {
      first = await log.waitFor((e) => isRead(e) || isTurnEnd(e), from, READ_TIMEOUT_MS, "the read");
    } catch (error) {
      result.outcome = error instanceof Timeout ? "hung" : "error";
      result.detail = String(error);
      return result;
    }
    if (first.type !== "item.completed") {
      result.outcome = "no-read";
      result.detail = `turn ended (${first.type}) before a completed read; tools: ${log.events
        .slice(from)
        .filter((e) => e.type === "item.completed" && e.item.kind === "tool_call")
        .map(itemSummary)
        .join(" | ")}`;
      return result;
    }
    // Gone before the interrupt, so no later answer can come from the disk.
    unlinkSync(filePath);
    result.readTool = itemSummary(first).slice(0, 160);
    result.readSawNonce = (first.item.detail ?? first.item.text).includes(nonce);
    const readIndex = log.events.indexOf(first);
    let interruptRefused = false;
    if (!CONTROL) {
      await withTimeout(service.interruptTurn(threadId), SETTLE_TIMEOUT_MS, "interruptTurn").catch((error) => {
        interruptRefused = true;
        result.detail = `interruptTurn: ${String(error)}`;
      });
    }
    let settled: RuntimeEvent;
    try {
      settled = await log.waitFor(
        isTurnEnd,
        readIndex,
        CONTROL ? READ_TIMEOUT_MS : SETTLE_TIMEOUT_MS,
        "interrupted turn to settle",
      );
    } catch {
      result.interruptSettle = "hung";
      result.outcome = "hung";
      return result;
    }
    result.interruptSettle = settled.type === "turn.aborted" ? `turn.aborted (${settled.reason})` : settled.type;
    result.sleepStarted = log.events
      .slice(readIndex)
      .some((e) => e.type === "item.started" && e.item.kind === "tool_call" && itemSummary(e).includes("sleep"));
    // Only a turn the interrupt actually cut short says anything about a cancel.
    const cancelled = !interruptRefused && settled.type === "turn.aborted" && settled.reason === "interrupted";
    if (!CONTROL && !cancelled) {
      result.outcome = "not-cancelled";
      return result;
    }

    if (mode === "resume") {
      for (const e of log.events) {
        const id = e.refs?.conversationId ?? (e.type === "turn.completed" ? e.conversationId : undefined);
        if (id) conversationId = id;
      }
      if (!conversationId) {
        result.detail = "no conversation id to resume";
        return result;
      }
      await stopQuietly(service, threadId);
      const resumed = await withTimeout(
        service.startSession({ ...start, resume: conversationId }),
        START_TIMEOUT_MS,
        "resume startSession",
      );
      result.resumedFrom = resumed.resumedFrom;
    }
    result.answer = await ask(
      service,
      log,
      threadId,
      mode === "live"
        ? "Without using any tools, what nonce was in the file you just read?"
        : "Without using any tools, what nonce was in the file you read earlier in this conversation?",
      nonce,
    );
    result.outcome = result.answer.outcome;
    return result;
  } catch (error) {
    result.outcome = error instanceof Timeout ? "hung" : "error";
    result.detail = [result.detail, String(error)].filter(Boolean).join("; ");
    return result;
  } finally {
    if (result.outcome !== "pass") result.trace = traceOf(log);
    await stopQuietly(service, threadId);
    rmSync(cwd, { recursive: true, force: true });
  }
}

async function probeTarget(target: Target): Promise<TargetResult> {
  const result: TargetResult = { id: target.id, model: target.model || "(default)", status: "ran", runs: [] };
  if (!isProviderEnabled(target.provider, readProviderSettings())) {
    return { ...result, status: "disabled", detail: "disabled in the user's provider settings" };
  }
  const logs = new Map<string, ThreadLog>();
  let adapter: ProviderAdapter | undefined;
  const service = new AgentService({
    retentionSweepMs: 0,
    checkpointStore: null,
    adapters: (emit) => {
      adapter = target.make(emit);
      return [adapter];
    },
  });
  service.onEvent((event) => {
    logs.get(event.threadId)?.push(event);
    // The read needs no approval in full-access, but a provider that asks
    // anyway must not park the run.
    if (event.type === "approval.requested") {
      void service.respondToRequest(event.threadId, event.requestId, "allow-once").catch(() => {});
    }
  });
  if (!adapter) throw new Error("adapter was not constructed");
  const status = await withTimeout(adapter.discover(), START_TIMEOUT_MS, "discover").catch((error) => ({
    available: false,
    readiness: "error",
    message: String(error),
    authStatus: "unknown",
  }));
  if (!status.available || status.authStatus === "unauthenticated") {
    return { ...result, status: "unavailable", detail: `${status.readiness}: ${status.message ?? ""}`.trim() };
  }
  for (const mode of ["live", "resume"] as const) {
    for (let run = 1; run <= RUNS; run++) {
      const r = await probeRun(service, logs, target, run, mode);
      console.log(`[${target.id}] ${mode} run ${run}: ${r.outcome} (${r.interruptSettle ?? "-"})`);
      result.runs.push(r);
    }
  }
  await withTimeout(service.stopAll(), STOP_TIMEOUT_MS, "stopAll").catch(() => {});
  return result;
}

const wanted = process.argv.slice(2);
const targets = wanted.length > 0 ? TARGETS.filter((t) => wanted.includes(t.id)) : TARGETS;
const results = await Promise.all(targets.map((t) => probeTarget(t)));

const count = (runs: RunResult[], pick: (r: RunResult) => string | undefined): string => {
  const tally = new Map<string, number>();
  for (const r of runs) tally.set(pick(r) ?? "-", (tally.get(pick(r) ?? "-") ?? 0) + 1);
  return [...tally].map(([k, n]) => `${k} ${n}/${runs.length}`).join(", ");
};
console.log("\n| Provider | Model | Live | After resume |");
console.log("|---|---|---|---|");
for (const r of results) {
  if (r.status !== "ran") {
    console.log(`| ${r.id} | ${r.model} | ${r.status}: ${r.detail ?? ""} | - |`);
    continue;
  }
  const live = r.runs.filter((x) => x.mode === "live");
  const resume = r.runs.filter((x) => x.mode === "resume");
  console.log(`| ${r.id} | ${r.model} | ${count(live, (x) => x.outcome)} | ${count(resume, (x) => x.outcome)} |`);
}
const out = path.join(tmpdir(), `kone-cancel-probe-${CONTROL ? "control-" : ""}${Date.now()}.json`);
writeFileSync(out, JSON.stringify(results, null, 2));
console.log(`\nFull results: ${out}`);
rmSync(probeUserData, { recursive: true, force: true });
process.exit(0);

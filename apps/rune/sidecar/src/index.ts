import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { z } from "zod";
import { clone } from "@kone/git-core/clone.js";
import { createProject } from "../../../desktop/src/modules/git/create.js";
import { readme, identity, logo, contributors } from "../../../desktop/src/modules/git/about.js";
import { provisionWorktree } from "../../../desktop/src/modules/git/worktreeProvision.js";
import { freshestBase } from "../../../desktop/src/modules/git/worktreeBase.js";
import { renameGeneratedBranch } from "../../../desktop/src/modules/git/worktreeBranchName.js";
import { removeWorktree } from "../../../desktop/src/modules/git/worktree.js";
import { createGateway } from "@kone/agent-core/gateway/index.js";
import { indexThreadGates, threadGateFor } from "@kone/agent-core/spawnProjection.js";
import { getAttachmentStore } from "@kone/agent-core/AttachmentStore.js";
import { initSpawnEngine } from "@kone/agent-core/threadSpawn.js";
import { acceptProviderThreadTitle } from "@kone/agent-core/threadTitle.js";
import { AgentService } from "@kone/agent-core/AgentService.js";
import { getConversationStore } from "@kone/agent-core/ConversationStore.js";
import { initThreadDispatcher } from "@kone/agent-core/dispatch.js";
import { projectRuntimeEventForIpc, projectStoredBlocksForIpc, projectStoredThreadForIpc } from "@kone/agent-core/conversationWire.js";
import { setUserDataDir } from "@kone/agent-core/userDataDir.js";
import type { RuntimeEvent, SendTurnInput, SessionStartInput } from "@kone/agent-core/types.js";
import type { StoredStudioLayout } from "@kone/agent-core/conversationStoreTypes.js";

const directory = process.env.KONE_RUNE_DATA_DIR;
if (!directory || !path.isAbsolute(directory)) throw new Error("KONE_RUNE_DATA_DIR must be an absolute isolated data directory");
await mkdir(directory, { recursive: true });
setUserDataDir(directory);
const store = getConversationStore();
const service = new AgentService();
const output = process.stdout;
// Library diagnostics must not corrupt the protocol stream.
console.log = (...args: unknown[]) => console.error(...args);
console.warn = (...args: unknown[]) => console.error(...args);
const send = <T>(value: T) => output.write(`${JSON.stringify(value)}\n`);
const notify = <T>(method: string, params: T) => send({ jsonrpc: "2.0", method, params });
const transient = new Set<RuntimeEvent["type"]>(["user-input.requested", "user-input.resolved", "approval.requested", "approval.resolved", "thread.spawned", "thread.spawn-updated", "thread.archived", "thread.unarchived", "thread.done.updated", "app.theme_mutation", "app.agent_mutation", "app.subagent_presets_changed", "app.strip_mutation", "app.typography_mutation", "bench.job-changed"]);
const dispatcher = initThreadDispatcher({
  service, store, broadcast,
  provisionWorkspace: (request) => provisionWorktree(request),
  freshenWorkspaceBase: ({ projectPath, base }) => freshestBase(projectPath, base),
  renameWorkspaceBranch: ({ worktreePath, title }) => renameGeneratedBranch(worktreePath, title),
  releaseWorkspace: ({ projectPath, worktreePath, reclaimGeneratedBranch }) => removeWorktree(projectPath, { path: worktreePath, reclaimGeneratedBranch }),
});
function broadcast(event: RuntimeEvent, journal = true): void {
  const stamped = { ...event, eventId: event.eventId ?? randomUUID(), parentTurnId: event.parentTurnId ?? dispatcher.spawnParentTurnId(event.threadId) };
  if (journal) store.applyEvent(stamped);
  notify("agent.event", projectRuntimeEventForIpc(stamped));
}
function gateTitle(event: RuntimeEvent): { event: RuntimeEvent; journal: boolean } | null {
  if (event.type !== "thread.title.updated" || event.source === "kone.store") return { event, journal: true };
  const title = acceptProviderThreadTitle({ hasSettledTurn: store.hasSettledAssistantTurn(event.threadId), proposedTitle: event.title });
  if (!title) return null;
  store.renameThread(event.threadId, title);
  return { event: { ...event, title }, journal: false };
}
initSpawnEngine({ store, providers: service, dispatcher, emit: (event) => {
  const gated = gateTitle(event);
  if (gated) broadcast(gated.event, false);
}, onEvents: (listener) => service.onEvent(listener) });
service.onEvent((incoming) => {
  const gated = gateTitle(incoming);
  if (!gated) return;
  const { event } = gated;
  broadcast(event, gated.journal && !transient.has(event.type));
  if (event.type === "turn.completed") dispatcher.onTurnCompleted(event.threadId);
});
const gateway = createGateway({
  store,
  emit: (event) => broadcast(event),
  onEvents: (listener) => service.onEvent(listener),
  isThreadLive: (threadId) => service.hasLiveSession(threadId),
  pendingGates: () => indexThreadGates(service.pendingInteractions()),
  pendingThreadGate: (threadId) => threadGateFor(indexThreadGates(service.pendingInteractions()), threadId),
  threads: { startThread: (input) => dispatcher.startThread(input), sendThreadTurn: (input, options) => dispatcher.sendThreadTurn(input, options) },
  threadAvailability: async () => {
    const surface = service.cachedSurface();
    return surface.statuses.map((status) => ({ provider: status.provider, available: status.available, models: (surface.models[status.provider] ?? []).map((model) => model.id) }));
  },
});
service.attachGateway(gateway);
void gateway.ready.then(() => dispatcher.resumeQuitInterruptedChatsAtBoot()).catch((error: Error) => console.error("[sidecar] resume failed:", error.message));
service.onProvidersChanged((statuses) => notify("agent.providersChanged", statuses));

const object = z.record(z.string(), z.unknown());
const thread = z.object({ threadId: z.string().min(1) });
const projectsFile = path.join(directory, "projects.json");
const project = z.object({ path: z.string().min(1), name: z.string().min(1), lastOpenedAt: z.number(), pinned: z.boolean().optional() });
type Project = z.infer<typeof project>;
async function projects(): Promise<Project[]> {
  try { return z.array(project).parse(JSON.parse(await readFile(projectsFile, "utf8"))); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}
let projectWrites = Promise.resolve();
function updateProjects(change: (list: Project[]) => Project[]): Promise<Project[]> {
  const result = projectWrites.then(async () => {
    const next = change(await projects());
    const temporary = `${projectsFile}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(next), { mode: 0o600 });
    await rename(temporary, projectsFile);
    return next;
  });
  projectWrites = result.then(() => undefined, () => undefined);
  return result;
}
async function call(method: string, params: z.infer<typeof object>) {
  switch (method) {
    case "initialize": return { version: 1, capabilities: ["projects", "studio", "agent"] };
    case "projects.list": return (await projects()).sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.lastOpenedAt - a.lastOpenedAt);
    case "projects.create": {
      const input = z.object({ parent: z.string(), name: z.string().min(1), git: z.boolean().optional(), readme: z.boolean().optional() }).parse(params);
      if (!path.isAbsolute(input.parent)) throw new Error("Parent path must be absolute");
      const result = await createProject({ ...input, git: input.git ?? false });
      return { path: result.root, name: result.name };
    }
    case "projects.clone": {
      const input = z.object({ url: z.string().min(1), parent: z.string(), name: z.string().min(1) }).parse(params);
      if (!path.isAbsolute(input.parent) || input.name === "." || input.name === ".." || /[/\\\0]/.test(input.name)) throw new Error("Invalid destination");
      const target = path.join(input.parent, input.name);
      await clone(input.url, target, (progress) => notify("projects.cloneProgress", progress));
      return { path: target, name: input.name };
    }
    case "projects.overview": {
      const input = z.object({ path: z.string().min(1) }).parse(params);
      const [projectReadme, projectIdentity, projectLogo, projectContributors] = await Promise.all([readme(input.path), identity(input.path), logo(input.path), contributors(input.path)]);
      return { readme: projectReadme, identity: projectIdentity, logo: projectLogo, contributors: projectContributors };
    }
    case "projects.remember": {
      const input = z.object({ path: z.string().min(1), name: z.string().min(1) }).parse(params);
      if (!path.isAbsolute(input.path)) throw new Error("Project path must be absolute");
      return updateProjects((list) => [{ ...input, lastOpenedAt: Date.now(), pinned: list.find((p) => p.path === input.path)?.pinned }, ...list.filter((p) => p.path !== input.path)].slice(0, 24));
    }
    case "projects.forget": { const input = z.object({ path: z.string() }).parse(params); return updateProjects((list) => list.filter((p) => p.path !== input.path)); }
    case "projects.pin": { const input = z.object({ path: z.string(), pinned: z.boolean() }).parse(params); return updateProjects((list) => list.map((p) => p.path === input.path ? { ...p, pinned: input.pinned } : p)); }
    case "studio.load": return store.loadStudio();
    case "studio.save": {
      const input = z.object({ layout: z.object({ version: z.literal(2), rows: z.array(z.unknown()) }).passthrough() }).parse(params);
      // SAFETY: The persisted layout has the version and rows checked here; pane validation belongs to the consumer, as in StudioRepo.
      return store.saveStudio(input.layout as StoredStudioLayout);
    }
    case "agent.surface": return service.cachedSurface();
    case "agent.warm": return service.warm();
    case "agent.discover": return service.discover();
    case "agent.models": { const input = z.object({ provider: z.enum(["codex", "claudeAgent", "opencode", "cursor", "droid", "antigravity"]) }).parse(params); return service.listModels(input.provider); }
    case "agent.start": {
      const input = z.object({ threadId: z.string().min(1), provider: z.enum(["codex", "claudeAgent", "opencode", "cursor", "droid", "antigravity"]), cwd: z.string().min(1) }).passthrough().parse(params);
      await gateway.ready;
      // SAFETY: Required session identity fields and provider are validated; optional provider parameters retain their shared wire types.
      return dispatcher.startThread(input as SessionStartInput);
    }
    case "agent.send": case "agent.steer": {
      const input = z.object({ threadId: z.string().min(1), input: z.string() }).passthrough().parse(params);
      // SAFETY: Required turn identity and text are validated; optional turn parameters retain their shared wire types.
      const turn = input as SendTurnInput;
      return method === "agent.send" ? dispatcher.sendThreadTurn(turn) : dispatcher.steerThreadTurn(turn);
    }
    case "agent.interrupt": return service.interruptTurn(thread.parse(params).threadId);
    case "agent.stop": return service.stopSession(thread.parse(params).threadId);
    case "agent.approval": {
      const input = z.object({ threadId: z.string(), requestId: z.string(), decision: z.enum(["allow-once", "allow-always", "reject-once", "reject-and-stop"]) }).parse(params);
      return service.respondToRequest(input.threadId, input.requestId, input.decision);
    }
    case "agent.userInput": {
      const input = z.object({ threadId: z.string(), requestId: z.string(), answers: z.record(z.string(), z.union([z.string(), z.array(z.string()), z.null()])) }).parse(params);
      return service.respondToUserInput(input.threadId, input.requestId, input.answers);
    }
    case "agent.pending": return service.pendingInteractions();
    case "agent.queue": return service.listQueuedTurns(thread.parse(params).threadId);
    case "agent.queueCancel": { const input = z.object({ threadId: z.string(), queueId: z.string() }).parse(params); return service.cancelQueuedTurn(input.threadId, input.queueId); }
    case "agent.queueReorder": { const input = z.object({ threadId: z.string(), queueIds: z.array(z.string()) }).parse(params); return service.reorderQueuedTurns(input.threadId, input.queueIds); }
    case "agent.uploadAttachment": {
      const input = z.object({ threadId: z.string(), name: z.string(), mimeType: z.string(), data: z.string() }).parse(params);
      return getAttachmentStore().save(input);
    }
    case "history.list": return store.listThreads(z.object({ projectPath: z.string() }).parse(params).projectPath);
    case "history.latest": return store.latestThreadMeta(z.object({ projectPath: z.string() }).parse(params).projectPath);
    case "history.thread": { const value = store.loadThread(thread.parse(params).threadId); return value ? projectStoredThreadForIpc(value) : null; }
    case "history.page": {
      const input = z.object({ threadId: z.string(), limit: z.number().int().positive().optional(), cursor: z.string().optional() }).parse(params);
      const value = store.loadThreadPage(input.threadId, { limit: input.limit, cursor: input.cursor });
      return value ? { ...value, blocks: projectStoredBlocksForIpc(value.blocks) } : null;
    }
    default: throw new Error(`Unknown method: ${method}`);
  }
}
const envelope = z.object({ jsonrpc: z.literal("2.0"), id: z.union([z.string(), z.number()]), method: z.string(), params: z.unknown().optional() });
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
const pending = new Set<Promise<void>>();
lines.on("line", (line) => {
  const task = (async () => {
    let id: string | number | null = null;
    try {
      const request = envelope.parse(JSON.parse(line));
      id = request.id;
      const result = await call(request.method, object.parse(request.params ?? {}));
      send({ jsonrpc: "2.0", id, result: result ?? null });
    } catch (error) {
      send({ jsonrpc: "2.0", id, error: { code: -32000, message: error instanceof Error ? error.message : "Request failed" } });
    }
  })();
  pending.add(task);
  void task.finally(() => pending.delete(task));
});
lines.on("close", () => { void Promise.allSettled(pending).then(() => service.stopAll()).then(() => gateway.shutdown()).finally(() => process.exit(0)); });

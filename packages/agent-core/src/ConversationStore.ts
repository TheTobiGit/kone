import { ConversationDb } from "./store/ConversationDb.js";
import { StudioRepo } from "./store/studio.js";
import { GatewayOpRepo } from "./store/gatewayOps.js";
import { AttachmentRowRepo } from "./store/attachmentRows.js";
import { WorkspaceRepo } from "./store/workspaces.js";
import { ScratchpadRepo } from "./store/scratchpads.js";
import { StatsRepo } from "./store/stats.js";
import { SubagentPresetRepo } from "./store/subagentPresets.js";
import { ThreadLifecycleRepo } from "./store/threadLifecycle.js";
import { QueuedTurnRepo } from "./store/queuedTurns.js";
import { TurnCheckpointRepo } from "./store/turnCheckpoints.js";
import { LineageRepo, type ForkThreadAtBlockResult } from "./store/lineage.js";
import { TranscriptRepo } from "./store/transcript.js";
import { RosterRepo } from "./store/roster.js";
import { ThreadRepo } from "./store/threads.js";
import { EventIngestRepo } from "./store/events.js";
import { SearchRepo } from "./store/search.js";
import type { ChatAttachment, CompactionRecord, ForkContext, InteractionMode, ProfileStats, ProviderKind, RuntimeEvent, StoredThread, StoredThreadMeta, ThreadLineage } from "./types.js";
import type { UsageRange } from "./usage/report.js";
import { type AgentCreateInput, type AgentDuplicateInput, type AgentPatch, type AgentRecord, type NativeSubagentConfig, type NativeSubagentConfigPatch, type SubagentPresetCreateInput, type SubagentPresetPatch, type SubagentPresetRecord, type ThreadAgentBinding } from "./rosterRecord.js";
import { type QueuedTurnEnqueueInput, type QueuedTurnRow, type ScratchpadRecord, type StoredAttachment, type StoredStudioLayout, type StoredThreadPage, type TurnCheckpointRecord, type TurnSpan, type TurnUsageRecord, type ConversationSearchHit, type ConversationSearchOptions, type CheckpointStore } from "./conversationStoreTypes.js";
import { type ThreadEnvMode, type ThreadWorkspace } from "./threadWorkspace.js";
import { GLOBAL_ASSISTANT_PROJECT_PATH } from "./conversationStoreTypes.js";

export { GLOBAL_ASSISTANT_PROJECT_PATH };

export class ConversationStore implements CheckpointStore {
  private readonly dbh: ConversationDb;
  private readonly studio: StudioRepo;
  private readonly gatewayOps: GatewayOpRepo;
  private readonly attachmentRows: AttachmentRowRepo;
  private readonly workspaces: WorkspaceRepo;
  private readonly scratchpads: ScratchpadRepo;
  private readonly stats: StatsRepo;
  private readonly subagentPresets: SubagentPresetRepo;
  private readonly threadLifecycle: ThreadLifecycleRepo;
  private readonly queuedTurns: QueuedTurnRepo;
  private readonly turnCheckpoints: TurnCheckpointRepo;
  private readonly lineage: LineageRepo;
  private readonly transcript: TranscriptRepo;
  private readonly roster: RosterRepo;
  private readonly threads: ThreadRepo;
  private readonly events: EventIngestRepo;
  private readonly search: SearchRepo;

  /** @param userDataDir per-user state dir; defaults to the one the host
   *  injected at startup (see userDataDir.ts). Tests pass a temp dir. */
  constructor(userDataDir?: string) {
    this.dbh = new ConversationDb(userDataDir);
    this.threads = new ThreadRepo(this.dbh);
    this.lineage = new LineageRepo(this.dbh);
    this.events = new EventIngestRepo(this.dbh, {
      touch: (db, threadId, at) => this.threads.touch(db, threadId, at),
      completeSidechatBootstrap: (db, threadId) =>
        this.lineage.completeSidechatBootstrap(db, threadId),
    });
    this.threadLifecycle = new ThreadLifecycleRepo(this.dbh, {
      forgetConversationIds: (ids) => this.events.forgetConversationIds(ids),
    });
    this.attachmentRows = new AttachmentRowRepo(this.dbh, {
      subtreeIds: (db, threadId) => this.threadLifecycle.subtreeIds(db, threadId),
    });
    this.workspaces = new WorkspaceRepo(this.dbh, {
      subtreeIds: (db, threadId) => this.threadLifecycle.subtreeIds(db, threadId),
    });
    this.transcript = new TranscriptRepo(this.dbh);
    this.queuedTurns = new QueuedTurnRepo(this.dbh);
    this.turnCheckpoints = new TurnCheckpointRepo(this.dbh);
    this.roster = new RosterRepo(this.dbh);
    this.subagentPresets = new SubagentPresetRepo(this.dbh);
    this.scratchpads = new ScratchpadRepo(this.dbh);
    this.gatewayOps = new GatewayOpRepo(this.dbh);
    this.studio = new StudioRepo(this.dbh);
    this.stats = new StatsRepo(this.dbh);
    this.search = new SearchRepo(this.dbh);
  }

  /** @see ThreadRepo */
  ensureThread(input: {
    threadId: string;
    projectPath: string;
    provider: ProviderKind;
    model?: string;
  }): void {
    return this.threads.ensureThread(input);
  }

  /** @see ThreadRepo */
  recordUserBlock(input: {
    blockId?: string;
    threadId: string;
    text: string;
    at?: number;
    attachments?: ChatAttachment[];
  }): number {
    return this.threads.recordUserBlock(input);
  }

  /** @see AttachmentRowRepo */
  registerAttachment(row: StoredAttachment): void {
    return this.attachmentRows.registerAttachment(row);
  }

  /** @see AttachmentRowRepo */
  listThreadAttachments(threadId: string): StoredAttachment[] {
    return this.attachmentRows.listThreadAttachments(threadId);
  }

  /** @see AttachmentRowRepo */
  listSubtreeAttachments(threadId: string): StoredAttachment[] {
    return this.attachmentRows.listSubtreeAttachments(threadId);
  }

  /** @see AttachmentRowRepo */
  getAttachment(id: string): StoredAttachment | null {
    return this.attachmentRows.getAttachment(id);
  }

  /** @see ThreadRepo */
  getTitle(threadId: string): string | null {
    return this.threads.getTitle(threadId);
  }

  /** @see ThreadRepo */
  setTitle(threadId: string, title: string): void {
    return this.threads.setTitle(threadId, title);
  }

  /** @see ThreadRepo */
  renameThread(threadId: string, title: string): boolean {
    return this.threads.renameThread(threadId, title);
  }

  /** @see ThreadRepo */
  setPinned(threadId: string, pinned: boolean): void {
    return this.threads.setPinned(threadId, pinned);
  }

  /** @see ThreadRepo */
  setDone(threadId: string, done: boolean): void {
    return this.threads.setDone(threadId, done);
  }

  /** @see ThreadRepo */
  setVisited(threadId: string, at: number, force = false): void {
    return this.threads.setVisited(threadId, at, force);
  }

  /** @see ThreadRepo */
  setThreadSelection(
    threadId: string,
    selection: {
      model?: string;
      effort?: string;
      serviceTier?: string;
      contextWindow?: string;
      mode?: InteractionMode | string;
    },
  ): void {
    return this.threads.setThreadSelection(threadId, selection);
  }

  /** @see EventIngestRepo */
  captureConversationId(threadId: string, conversationId: string): void {
    return this.events.captureConversationId(threadId, conversationId);
  }

  /** @see EventIngestRepo */
  applyEvent(event: RuntimeEvent): void {
    return this.events.applyEvent(event);
  }

  /** @see EventIngestRepo */
  recordRepoStats(input: {
    threadId: string;
    branch?: string | null;
    added?: number;
    removed?: number;
  }): void {
    return this.events.recordRepoStats(input);
  }

  /** @see EventIngestRepo */
  getBaseline(threadId: string): string | null {
    return this.events.getBaseline(threadId);
  }

  /** @see EventIngestRepo */
  setBaseline(threadId: string, baseTree: string): void {
    return this.events.setBaseline(threadId, baseTree);
  }

  /** @see QueuedTurnRepo */
  enqueueQueuedTurn(input: QueuedTurnEnqueueInput): boolean {
    return this.queuedTurns.enqueueQueuedTurn(input);
  }

  /** @see QueuedTurnRepo */
  claimNextQueuedTurn(threadId: string, staleTimeoutMs = 120_000): QueuedTurnRow | null {
    return this.queuedTurns.claimNextQueuedTurn(threadId, staleTimeoutMs);
  }

  /** @see QueuedTurnRepo */
  recoverStaleClaims(staleTimeoutMs = 120_000): number {
    return this.queuedTurns.recoverStaleClaims(staleTimeoutMs);
  }

  /** @see QueuedTurnRepo */
  markQueuedTurnPromoted(queueId: string): boolean {
    return this.queuedTurns.markQueuedTurnPromoted(queueId);
  }

  /** @see QueuedTurnRepo */
  releaseQueuedTurn(queueId: string): boolean {
    return this.queuedTurns.releaseQueuedTurn(queueId);
  }

  /** @see QueuedTurnRepo */
  reorderQueuedTurns(threadId: string, queueIds: string[]): boolean {
    return this.queuedTurns.reorderQueuedTurns(threadId, queueIds);
  }

  /** @see QueuedTurnRepo */
  cancelQueuedTurn(queueId: string): boolean {
    return this.queuedTurns.cancelQueuedTurn(queueId);
  }

  /** @see QueuedTurnRepo */
  cancelQueuedTurnsForThread(threadId: string): string[] {
    return this.queuedTurns.cancelQueuedTurnsForThread(threadId);
  }

  /** @see QueuedTurnRepo */
  listQueuedTurns(threadId: string): QueuedTurnRow[] {
    return this.queuedTurns.listQueuedTurns(threadId);
  }

  /** @see TurnCheckpointRepo */
  recordTurnCheckpoint(input: {
    threadId: string;
    turnId: string;
    checkpointId: string;
    ref: string;
    createdAt?: number;
  }): boolean {
    return this.turnCheckpoints.recordTurnCheckpoint(input);
  }

  /** @see TurnCheckpointRepo */
  getTurnCheckpoint(threadId: string, turnId: string): TurnCheckpointRecord | null {
    return this.turnCheckpoints.getTurnCheckpoint(threadId, turnId);
  }

  /** @see TurnCheckpointRepo */
  listTurnCheckpoints(threadId: string): TurnCheckpointRecord[] {
    return this.turnCheckpoints.listTurnCheckpoints(threadId);
  }

  /** @see TurnCheckpointRepo */
  deleteTurnCheckpoint(threadId: string, turnId: string): TurnCheckpointRecord | null {
    return this.turnCheckpoints.deleteTurnCheckpoint(threadId, turnId);
  }

  /** @see TurnCheckpointRepo */
  pruneTurnCheckpoints(threadId: string, keep: number): TurnCheckpointRecord[] {
    return this.turnCheckpoints.pruneTurnCheckpoints(threadId, keep);
  }

  /** @see EventIngestRepo */
  listCompactions(threadId: string): CompactionRecord[] {
    return this.events.listCompactions(threadId);
  }

  /** @see TranscriptRepo */
  listTurnUsage(threadId: string): TurnUsageRecord[] {
    return this.transcript.listTurnUsage(threadId);
  }

  /** @see ThreadLifecycleRepo */
  canDeleteThread(threadId: string): { ok: true } | { ok: false; reason: "missing" | "busy" } {
    return this.threadLifecycle.canDeleteThread(threadId);
  }

  /** @see ThreadLifecycleRepo */
  setArchived(
    threadId: string,
    archived: boolean,
  ): { ok: true; threadIds: string[] } | { ok: false; reason: "missing" | "busy" | "error" } {
    return this.threadLifecycle.setArchived(threadId, archived);
  }

  /** @see ThreadLifecycleRepo */
  staleThreadIds(options: {
    unusedMs: number;
    limit: number;
    undone?: boolean;
  }): string[] {
    return this.threadLifecycle.staleThreadIds(options);
  }

  /** @see ThreadLifecycleRepo */
  deleteThread(
    threadId: string,
  ): { ok: true } | { ok: false; reason: "missing" | "busy" | "error" } {
    return this.threadLifecycle.deleteThread(threadId);
  }

  /** @see AttachmentRowRepo */
  listAllAttachments(): StoredAttachment[] {
    return this.attachmentRows.listAllAttachments();
  }

  /** @see AttachmentRowRepo */
  forgetAttachment(attachmentId: string): void {
    return this.attachmentRows.forgetAttachment(attachmentId);
  }

  /** @see ThreadRepo */
  threadProjectPath(threadId: string): string | null {
    return this.threads.threadProjectPath(threadId);
  }

  /** @see WorkspaceRepo */
  threadWorkspace(threadId: string): ThreadWorkspace | null {
    return this.workspaces.threadWorkspace(threadId);
  }

  /** @see WorkspaceRepo */
  setThreadWorkspace(
    threadId: string,
    input: { envMode?: ThreadEnvMode; worktreePath?: string | null; requestedBranch?: string | null },
  ): void {
    return this.workspaces.setThreadWorkspace(threadId, input);
  }

  /** @see WorkspaceRepo */
  subtreeWorkspaces(
    threadId: string,
  ): Array<{ threadId: string; projectPath: string; worktreePath: string }> {
    return this.workspaces.subtreeWorkspaces(threadId);
  }

  /** @see WorkspaceRepo */
  isWorktreePathReferenced(worktreePath: string): boolean {
    return this.workspaces.isWorktreePathReferenced(worktreePath);
  }

  /** @see ThreadRepo */
  isAssistantThread(threadId: string): boolean {
    return this.threads.isAssistantThread(threadId);
  }

  /** @see ThreadRepo */
  listAssistantThreads(): StoredThreadMeta[] {
    return this.threads.listAssistantThreads();
  }

  /** @see ThreadRepo */
  threadMeta(threadId: string): StoredThreadMeta | null {
    return this.threads.threadMeta(threadId);
  }

  /** @see ThreadRepo */
  latestThreadMeta(projectPath: string): StoredThreadMeta | null {
    return this.threads.latestThreadMeta(projectPath);
  }

  /** @see ThreadRepo */
  latestUserBlockId(threadId: string): string | null {
    return this.threads.latestUserBlockId(threadId);
  }

  /** @see TranscriptRepo */
  loadThread(threadId: string): StoredThread | null {
    return this.transcript.loadThread(threadId);
  }

  /** @see TranscriptRepo */
  loadThreadPage(
    threadId: string,
    options?: { limit?: number; maxRaw?: number; cursor?: string },
  ): StoredThreadPage | null {
    return this.transcript.loadThreadPage(threadId, options);
  }

  /** @see ThreadRepo */
  listThreads(projectPath: string, options?: { archived?: boolean }): StoredThreadMeta[] {
    return this.threads.listThreads(projectPath, options);
  }

  /** @see StatsRepo */
  profileStats(): ProfileStats {
    return this.stats.profileStats();
  }

  /** @see StatsRepo */
  readStoreUsageReport(options: {
    range: UsageRange;
    projectPath?: string | null;
    excludeProviders?: string[];
    onlyProviders?: readonly string[];
  }) {
    return this.stats.readStoreUsageReport(options);
  }

  /** @see ThreadRepo */
  hasUserTurn(threadId: string): boolean {
    return this.threads.hasUserTurn(threadId);
  }

  /** @see ThreadRepo */
  threadExists(threadId: string): boolean {
    return this.threads.threadExists(threadId);
  }

  /** @see EventIngestRepo */
  threadIdForRequestId(requestId: string): string | null {
    return this.events.threadIdForRequestId(requestId);
  }

  /** @see LineageRepo */
  sidechatForSource(sourceThreadId: string): { threadId: string; provider: ProviderKind } | null {
    return this.lineage.sidechatForSource(sourceThreadId);
  }

  /** @see TranscriptRepo */
  hasNativeAssistantTurn(threadId: string): boolean {
    return this.transcript.hasNativeAssistantTurn(threadId);
  }

  /** @see LineageRepo */
  threadForkContext(threadId: string): ForkContext | null {
    return this.lineage.threadForkContext(threadId);
  }

  /** @see LineageRepo */
  writeForkThread(input: {
    threadId: string;
    projectPath: string;
    provider: ProviderKind;
    model?: string;
    createdAt: number;
    title?: string;
    sourceThreadId: string;
    forkContext: ForkContext;
    lineage: ThreadLineage;
    requestId?: string;
    /** Imported blocks in arrival order. Assistant rows carry their narrative
     *  as text — the source's tool items are not imported — and get a
     *  synthetic turn id so loadThread re-attaches that narrative as one
     *  `assistant_text` item (an assistant block with no items would read as
     *  an empty reply). */
    importedBlocks: Array<{
      id: string;
      role: "user" | "assistant";
      text: string;
      at: number;
      attachments?: ChatAttachment[];
    }>;
  }): boolean {
    return this.lineage.writeForkThread(input);
  }

  /** @see LineageRepo */
  forkThreadAtBlock(input: {
    threadId: string;
    sourceThreadId: string;
    blockId: string;
    editedText: string;
    editedAt?: number;
    editedBlockId?: string;
    requestId?: string;
  }): ForkThreadAtBlockResult {
    return this.lineage.forkThreadAtBlock(input);
  }

  /** @see LineageRepo */
  writeSpawnedThread(input: {
    threadId: string;
    projectPath: string;
    provider: ProviderKind;
    model?: string;
    createdAt: number;
    title: string;
    lineage: ThreadLineage;
  }): boolean {
    return this.lineage.writeSpawnedThread(input);
  }

  /** @see LineageRepo */
  retargetSpawnedThread(threadId: string, provider: ProviderKind, model?: string): void {
    return this.lineage.retargetSpawnedThread(threadId, provider, model);
  }

  /** @see LineageRepo */
  threadLineage(threadId: string): ThreadLineage | null {
    return this.lineage.threadLineage(threadId);
  }

  /** @see LineageRepo */
  spawnedChildren(parentThreadId: string): StoredThreadMeta[] {
    return this.lineage.spawnedChildren(parentThreadId);
  }

  /** @see LineageRepo */
  spawnDepth(threadId: string): number {
    return this.lineage.spawnDepth(threadId);
  }

  /** @see LineageRepo */
  liveSpawnedThreadIds(): string[] {
    return this.lineage.liveSpawnedThreadIds();
  }

  /** @see TranscriptRepo */
  latestAssistantText(threadId: string): string | null {
    return this.transcript.latestAssistantText(threadId);
  }

  /** @see TranscriptRepo */
  threadTurnSpan(threadId: string): TurnSpan | null {
    return this.transcript.threadTurnSpan(threadId);
  }

  /** @see TranscriptRepo */
  threadTurnSpans(threadIds: readonly string[]): Map<string, TurnSpan> {
    return this.transcript.threadTurnSpans(threadIds);
  }

  /** @see ScratchpadRepo */
  listScratchpads(projectPath: string): ScratchpadRecord[] {
    return this.scratchpads.listScratchpads(projectPath);
  }

  /** @see ScratchpadRepo */
  getScratchpad(padId: string): ScratchpadRecord | null {
    return this.scratchpads.getScratchpad(padId);
  }

  /** @see ScratchpadRepo */
  saveScratchpad(input: {
    padId: string;
    projectPath: string;
    title: string;
    body: string;
    expectedRevision?: number;
    append?: boolean;
  }): { savedAt: number; revision: number } | { conflict: number } | null {
    return this.scratchpads.saveScratchpad(input);
  }

  /** @see ScratchpadRepo */
  deleteScratchpad(padId: string): void {
    return this.scratchpads.deleteScratchpad(padId);
  }

  /** @see GatewayOpRepo */
  reserveGatewayOp(input: {
    threadId: string;
    turnId: string;
    requestId: string;
    kind: string;
    fingerprint: string;
  }): { kind: "reserved" } | { kind: "replay"; result: unknown } | { kind: "conflict" } | null {
    return this.gatewayOps.reserveGatewayOp(input);
  }

  /** @see GatewayOpRepo */
  setGatewayOpResult(input: {
    threadId: string;
    turnId: string;
    requestId: string;
    resultJson: string;
  }): void {
    return this.gatewayOps.setGatewayOpResult(input);
  }

  /** @see GatewayOpRepo */
  markGatewayOpDispatched(input: {
    threadId: string;
    turnId: string;
    requestId: string;
  }): void {
    return this.gatewayOps.markGatewayOpDispatched(input);
  }

  /** @see RosterRepo */
  ensurePresetAgents(presetIds: readonly string[]): void {
    return this.roster.ensurePresetAgents(presetIds);
  }

  /** @see RosterRepo */
  listAgents(options?: { includeDeleted?: boolean }): AgentRecord[] {
    return this.roster.listAgents(options);
  }

  /** @see RosterRepo */
  getAgent(agentId: string): AgentRecord | null {
    return this.roster.getAgent(agentId);
  }

  /** @see RosterRepo */
  createAgent(input: AgentCreateInput): AgentRecord | null {
    return this.roster.createAgent(input);
  }

  /** @see RosterRepo */
  updateAgent(agentId: string, patch: AgentPatch): AgentRecord | null {
    return this.roster.updateAgent(agentId, patch);
  }

  /** @see RosterRepo */
  deleteAgent(agentId: string): boolean {
    return this.roster.deleteAgent(agentId);
  }

  /** @see RosterRepo */
  duplicateAgent(input: AgentDuplicateInput): AgentRecord | null {
    return this.roster.duplicateAgent(input);
  }

  /** @see RosterRepo */
  addAgentToProject(projectPath: string, agentId: string): boolean {
    return this.roster.addAgentToProject(projectPath, agentId);
  }

  /** @see RosterRepo */
  removeAgentFromProject(projectPath: string, agentId: string): void {
    return this.roster.removeAgentFromProject(projectPath, agentId);
  }

  /** @see RosterRepo */
  listProjectAgents(projectPath: string): AgentRecord[] {
    return this.roster.listProjectAgents(projectPath);
  }

  /** @see SubagentPresetRepo */
  listSubagentPresets(): SubagentPresetRecord[] {
    return this.subagentPresets.listSubagentPresets();
  }

  /** @see SubagentPresetRepo */
  getSubagentPreset(presetId: string): SubagentPresetRecord | null {
    return this.subagentPresets.getSubagentPreset(presetId);
  }

  /** @see SubagentPresetRepo */
  createSubagentPreset(input: SubagentPresetCreateInput): SubagentPresetRecord | null {
    return this.subagentPresets.createSubagentPreset(input);
  }

  /** @see SubagentPresetRepo */
  updateSubagentPreset(
    presetId: string,
    patch: SubagentPresetPatch,
  ): SubagentPresetRecord | null {
    return this.subagentPresets.updateSubagentPreset(presetId, patch);
  }

  /** @see SubagentPresetRepo */
  deleteSubagentPreset(presetId: string): boolean {
    return this.subagentPresets.deleteSubagentPreset(presetId);
  }

  /** @see SubagentPresetRepo */
  listNativeSubagentConfigs(): NativeSubagentConfig[] {
    return this.subagentPresets.listNativeSubagentConfigs();
  }

  /** @see SubagentPresetRepo */
  getNativeSubagentConfig(presetId: string): NativeSubagentConfig {
    return this.subagentPresets.getNativeSubagentConfig(presetId);
  }

  /** @see SubagentPresetRepo */
  setNativeSubagentConfig(
    presetId: string,
    patch: NativeSubagentConfigPatch,
  ): NativeSubagentConfig | null {
    return this.subagentPresets.setNativeSubagentConfig(presetId, patch);
  }

  /** @see SubagentPresetRepo */
  listVisiblePresets(): SubagentPresetRecord[] {
    return this.subagentPresets.listVisiblePresets();
  }

  /** @see RosterRepo */
  listThreadAgents(): ThreadAgentBinding[] {
    return this.roster.listThreadAgents();
  }

  /** @see RosterRepo */
  getThreadAgent(threadId: string): ThreadAgentBinding | null {
    return this.roster.getThreadAgent(threadId);
  }

  /** @see RosterRepo */
  bindThreadAgent(threadId: string, agentId: string | null): ThreadAgentBinding | null {
    return this.roster.bindThreadAgent(threadId, agentId);
  }

  /** @see RosterRepo */
  carryThreadAgent(fromThreadId: string, toThreadId: string): ThreadAgentBinding | null {
    return this.roster.carryThreadAgent(fromThreadId, toThreadId);
  }

  /** @see RosterRepo */
  readSelectedAgent(): string | null {
    return this.roster.readSelectedAgent();
  }

  /** @see RosterRepo */
  writeSelectedAgent(agentId: string | null): void {
    return this.roster.writeSelectedAgent(agentId);
  }

  /** @see StudioRepo */
  loadStudio(): StoredStudioLayout | null {
    return this.studio.loadStudio();
  }

  /** @see StudioRepo */
  saveStudio(layout: StoredStudioLayout): { savedAt: number } | null {
    return this.studio.saveStudio(layout);
  }

  /** @see SearchRepo */
  searchConversations(query: string, options?: ConversationSearchOptions): ConversationSearchHit[] {
    return this.search.searchConversations(query, options);
  }

  /** @see ConversationDb */
  close(): void {
    return this.dbh.close();
  }
}

// ── singleton ────────────────────────────────────────────────────────────────

let store: ConversationStore | null = null;

/** The single ConversationStore instance (lazily created). */
export function getConversationStore(): ConversationStore {
  if (!store) store = new ConversationStore();
  return store;
}

/** Drop the module-level singleton so tests start from a clean instance. */
export function resetConversationStoreForTests(): void {
  if (store) {
    store.close();
    store = null;
  }
}

// ── Re-exports ───────────────────────────────────────────────────────────────

export * from "./conversationMigrations.js";
export * from "./rosterRecord.js";
export * from "./conversationStoreTypes.js";
export * from "./conversationWire.js";

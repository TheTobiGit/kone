import { ConversationDb } from "./store/ConversationDb.js";
import { StudioRepo } from "./store/studio.js";
import { GatewayOpRepo } from "./store/gatewayOps.js";
import { AttachmentRowRepo } from "./store/attachmentRows.js";
import { WorkspaceRepo } from "./store/workspaces.js";
import { ScratchpadRepo } from "./store/scratchpads.js";
import { JobRepo, type ClaimedJob, type JobRunOutcome } from "./store/jobs.js";
import { ScheduleRepo } from "./store/schedules.js";
import { StatsRepo } from "./store/stats.js";
import { SubagentPresetRepo } from "./store/subagentPresets.js";
import { ModelPreferenceRepo } from "./store/modelPreferences.js";
import type { ModelPreference } from "./modelPreference.js";
import { ThreadLifecycleRepo } from "./store/threadLifecycle.js";
import { QueuedTurnRepo } from "./store/queuedTurns.js";
import { AgentInboxRepo, type AgentInboxStore, type InboxChangeListener, type InboxClaim, type InboxInsert, type InboxRing, type InboxInsertResult, type InboxRow, type InboxSeenVia, type SentInboxQuery } from "./store/agentInbox.js";
import { TurnCheckpointRepo } from "./store/turnCheckpoints.js";
import { AgentGrantRepo } from "./store/agentGrants.js";
import { CrewBoardRepo } from "./store/crewBoards.js";
import { ThreadTaskRepo, type ThreadTasksDraft } from "./store/threadTasks.js";
import type { KoneTaskList } from "@kone/protocol/kone-tasks";
import type { BoardMember, BoardRow, BoardRule, BoardWrite, CrewBoard, CrewBoardStore } from "./crewBoard.js";
import type { AgentGrant } from "./agentAccess.js";
import { TurnRollbackRepo } from "./store/turnRollbacks.js";
import { LineageRepo, type ForkThreadAtBlockResult, type SpawnedChildrenPage, type SpawnedChildrenPageOptions } from "./store/lineage.js";
import { HandInsRepo } from "./store/handIns.js";
import { ProviderModelOptionsRepo, type ProviderModelOptionsInput, type ProviderModelOptionsRecord } from "./store/providerModelOptions.js";
import { ModelChangeRepo, type ModelChangeRecord } from "./store/modelChanges.js";
import { resolveSelectionKnobs, selectionKnobs, type SelectionKnobs, type TurnSelection } from "./selection.js";
import { TranscriptRepo } from "./store/transcript.js";
import { RosterRepo } from "./store/roster.js";
import { ThreadRepo } from "./store/threads.js";
import { ThreadPullRequestRepo } from "./store/threadPullRequest.js";
import { ThreadReferenceRepo } from "./store/threadReferences.js";
import { ProjectScriptRepo, type ProjectScriptKind } from "./store/projectScripts.js";
import type {
  ThreadPullRequestLink,
  ThreadPullRequestLinkInput,
} from "./threadPullRequest.js";
import type { LinkedPullRequestThread } from "./store/threadPullRequest.js";
import type { ThreadPullRequestCandidate } from "./store/threadPullRequest.js";
import { EventIngestRepo } from "./store/events.js";
import { SearchRepo } from "./store/search.js";
import type { ChatAttachment, CompactionRecord, ContinuationLink, ContractTerms, ForkContext, HandInRecord, InteractionMode, MessageSender, ProfileStats, ProviderKind, RuntimeEvent, SkillReference, StoredThread, StoredThreadMeta, ThreadLineage, TurnStamp } from "./types.js";
import type { UsageRange } from "./usage/report.js";
import { type AgentCreateInput, type AgentDuplicateInput, type AgentPatch, type AgentRecord, type NativeSubagentConfig, type NativeSubagentConfigPatch, type SubagentPresetCreateInput, type SubagentPresetPatch, type SubagentPresetRecord, type ThreadAgentBinding, type ThreadAgentRoute } from "./rosterRecord.js";
import { type QueuedTurnEnqueueInput, type QueuedTurnEditPatch, type QueuedTurnRow, type ScratchpadRecord, type StoredAttachment, type StoredStudioLayout, type StoredThreadPage, type TurnCheckpointRecord, type TurnSeal, type TurnSpan, type TurnUsageRecord, type ConversationSearchHit, type ConversationSearchOptions, type CheckpointStore, type JobCreateInput, type JobPatch, type JobRow, type JobRunRow, type ScheduleCreateInput, type SchedulePatch, type ScheduleRow, type ScheduleFireResult } from "./conversationStoreTypes.js";
import type { RestartCancelledBackgroundWork } from "./restartBackgroundNote.js";
import { ContinuationRepo, type ContinuationRecord } from "./store/continuations.js";
import { type IdleWorktree, type ThreadEnvMode, type ThreadWorkspace } from "./threadWorkspace.js";
import { GLOBAL_ASSISTANT_PROJECT_PATH } from "./conversationStoreTypes.js";
import type { ContractClosedReason } from "@kone/protocol/contract";

export { GLOBAL_ASSISTANT_PROJECT_PATH };

export class ConversationStore implements CrewBoardStore, CheckpointStore, AgentInboxStore {
  private readonly dbh: ConversationDb;
  private readonly studio: StudioRepo;
  private readonly gatewayOps: GatewayOpRepo;
  private readonly attachmentRows: AttachmentRowRepo;
  private readonly workspaces: WorkspaceRepo;
  private readonly scratchpads: ScratchpadRepo;
  private readonly jobs: JobRepo;
  private readonly schedules: ScheduleRepo;
  private readonly stats: StatsRepo;
  private readonly subagentPresets: SubagentPresetRepo;
  private readonly modelPreferences: ModelPreferenceRepo;
  private readonly threadLifecycle: ThreadLifecycleRepo;
  private readonly queuedTurns: QueuedTurnRepo;
  private readonly agentInbox: AgentInboxRepo;
  private readonly turnCheckpoints: TurnCheckpointRepo;
  private readonly agentGrants: AgentGrantRepo;
  private readonly crewBoards: CrewBoardRepo;
  private readonly threadTasks: ThreadTaskRepo;
  private readonly continuations: ContinuationRepo;
  private readonly turnRollbacks: TurnRollbackRepo;
  private readonly lineage: LineageRepo;
  private readonly handIns: HandInsRepo;
  private readonly providerModelOptions: ProviderModelOptionsRepo;
  private readonly modelChanges: ModelChangeRepo;
  private readonly transcript: TranscriptRepo;
  private readonly roster: RosterRepo;
  private readonly threads: ThreadRepo;
  private readonly threadPullRequests: ThreadPullRequestRepo;
  private readonly threadReferences: ThreadReferenceRepo;
  private readonly projectScripts: ProjectScriptRepo;
  private readonly events: EventIngestRepo;
  private readonly search: SearchRepo;

  /** @param userDataDir per-user state dir; defaults to the one the host
   *  injected at startup (see userDataDir.ts). Tests pass a temp dir. */
  constructor(userDataDir?: string) {
    this.dbh = new ConversationDb(userDataDir);
    this.threads = new ThreadRepo(this.dbh);
    this.threadPullRequests = new ThreadPullRequestRepo(this.dbh);
    this.threadReferences = new ThreadReferenceRepo(this.dbh);
    this.projectScripts = new ProjectScriptRepo(this.dbh);
    this.lineage = new LineageRepo(this.dbh);
    this.handIns = new HandInsRepo(this.dbh);
    this.providerModelOptions = new ProviderModelOptionsRepo(this.dbh);
    this.modelChanges = new ModelChangeRepo(this.dbh);
    this.events = new EventIngestRepo(this.dbh, {
      touch: (db, threadId, at) => this.threads.touch(db, threadId, at),
      completeSidechatBootstrap: (db, threadId) =>
        this.lineage.completeSidechatBootstrap(db, threadId),
      completeHandInBootstrap: (db, threadId) =>
        this.handIns.completeHandInBootstrap(db, threadId),
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
    this.agentInbox = new AgentInboxRepo(this.dbh);
    this.turnCheckpoints = new TurnCheckpointRepo(this.dbh);
    this.agentGrants = new AgentGrantRepo(this.dbh);
    this.crewBoards = new CrewBoardRepo(this.dbh);
    this.threadTasks = new ThreadTaskRepo(this.dbh);
    this.continuations = new ContinuationRepo(this.dbh);
    this.turnRollbacks = new TurnRollbackRepo(this.dbh);
    this.roster = new RosterRepo(this.dbh);
    this.subagentPresets = new SubagentPresetRepo(this.dbh);
    this.modelPreferences = new ModelPreferenceRepo(this.dbh);
    this.scratchpads = new ScratchpadRepo(this.dbh);
    this.jobs = new JobRepo(this.dbh);
    this.schedules = new ScheduleRepo(this.dbh);
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
    skills?: SkillReference[];
    sender?: MessageSender;
  } & TurnStamp): number {
    return this.threads.recordUserBlock(input);
  }

  /** @see ThreadRepo */
  discardUnsentUserBlock(threadId: string, blockId: string): boolean {
    return this.threads.discardUnsentUserBlock(threadId, blockId);
  }

  /** @see ThreadRepo */
  markUserBlockSteered(threadId: string, blockId: string, turnId?: string, at?: number): void {
    this.threads.markUserBlockSteered(threadId, blockId, turnId, at);
  }

  /** @see AttachmentRowRepo */
  registerAttachment(row: StoredAttachment): boolean {
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
  setTitleIfAuto(threadId: string, expectedTitle: string | null, title: string): boolean {
    return this.threads.setTitleIfAuto(threadId, expectedTitle, title);
  }

  /** @see ThreadRepo */
  renameThread(threadId: string, title: string): boolean {
    return this.threads.renameThread(threadId, title);
  }

  /** @see ThreadRepo */
  titleOrigin(threadId: string): "auto" | "manual" {
    return this.threads.titleOrigin(threadId);
  }

  /** @see ThreadPullRequestRepo */
  threadPullRequestLink(threadId: string): ThreadPullRequestLink | null {
    return this.threadPullRequests.link(threadId);
  }

  /** @see ThreadPullRequestRepo */
  setThreadPullRequestLink(threadId: string, input: ThreadPullRequestLinkInput): boolean {
    return this.threadPullRequests.setLink(threadId, input);
  }

  /** @see ThreadPullRequestRepo */
  clearThreadPullRequestLink(threadId: string): boolean {
    return this.threadPullRequests.clearLink(threadId);
  }

  listThreadReferences(ownerThreadId: string): string[] {
    return this.threadReferences.list(ownerThreadId);
  }

  attachThreadReference(ownerThreadId: string, targetThreadId: string, createdAt?: number): boolean {
    return this.threadReferences.attach(ownerThreadId, targetThreadId, createdAt);
  }

  detachThreadReference(ownerThreadId: string, targetThreadId: string): boolean {
    return this.threadReferences.detach(ownerThreadId, targetThreadId);
  }

  /** @see ThreadPullRequestRepo */
  recordThreadPullRequestChecked(
    threadId: string,
    input: { state: ThreadPullRequestLink["state"]; mergedAt: number | null; checkedAt: number },
  ): void {
    return this.threadPullRequests.recordChecked(threadId, input);
  }

  /** @see ThreadPullRequestRepo */
  recordThreadPullRequestAttempt(threadId: string, checkedAt: number): void {
    return this.threadPullRequests.recordAttempt(threadId, checkedAt);
  }

  /** @see ThreadPullRequestRepo */
  threadIsSettleEligible(threadId: string): boolean {
    return this.threadPullRequests.threadIsSettleEligible(threadId);
  }

  /** @see ThreadPullRequestRepo */
  threadPullRequestCandidate(threadId: string): ThreadPullRequestCandidate | null {
    return this.threadPullRequests.threadPullRequestCandidate(threadId);
  }

  /** @see ThreadPullRequestRepo */
  linkedThreadPullRequests(limit: number): LinkedPullRequestThread[] {
    return this.threadPullRequests.linkedThreads(limit);
  }

  /** @see ThreadPullRequestRepo */
  settleThreadPullRequestCandidates(
    limit: number,
    notCheckedAfter: number,
  ): ThreadPullRequestCandidate[] {
    return this.threadPullRequests.settleCandidates(limit, notCheckedAfter);
  }

  /** @see ThreadLifecycleRepo */
  threadIsBusy(threadId: string): boolean {
    return this.threadLifecycle.threadIsBusy(threadId);
  }

  /** @see TranscriptRepo */
  latestUserAuthoredAt(threadId: string): number | null {
    return this.transcript.latestUserAuthoredAt(threadId);
  }

  /** @see ProjectScriptRepo */
  projectScript(projectPath: string, kind: ProjectScriptKind): string | null {
    return this.projectScripts.script(projectPath, kind);
  }

  /** @see ProjectScriptRepo */
  setProjectScript(projectPath: string, kind: ProjectScriptKind, command: string | null): void {
    return this.projectScripts.setScript(projectPath, kind, command);
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
  setLimited(threadId: string, resetAt: number | null): void {
    return this.threads.setLimited(threadId, resetAt);
  }

  /** @see ThreadRepo */
  clearLimited(threadId: string): void {
    return this.threads.clearLimited(threadId);
  }

  /** @see ThreadRepo */
  setSnooze(threadId: string, until: number | null): void {
    return this.threads.setSnooze(threadId, until);
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
    const before = this.threads.threadMeta(threadId);
    this.threads.setThreadSelection(threadId, selection);
    // A picker commit teaches the same memory a turn does: the effective knobs
    // for the provider+model it chose, resolved the same way a returning pick
    // reads them, and never replacing memory with an empty set.
    const model = selection.model ?? before?.model;
    if (!before || !model) return;
    const explicit: SelectionKnobs = {};
    if (selection.effort !== undefined) explicit.effort = selection.effort;
    if (selection.serviceTier !== undefined) explicit.serviceTier = selection.serviceTier;
    if (selection.contextWindow !== undefined) explicit.contextWindow = selection.contextWindow;
    if (selection.mode === "ask" || selection.mode === "accept-edits" || selection.mode === "full-access") {
      explicit.mode = selection.mode;
    }
    const remembered = this.providerModelOptions.get(before.provider, model)?.knobs ?? null;
    const knobs = resolveSelectionKnobs({ explicit, remembered, current: selectionKnobs(before) });
    if (Object.keys(knobs).length === 0) return;
    this.providerModelOptions.upsert({ provider: before.provider, model, knobs });
  }

  /** The pick a thread holds for its next turn end. @see ThreadRepo */
  setPendingSelection(threadId: string, selection: TurnSelection): void {
    return this.threads.setPendingSelection(threadId, selection);
  }

  /** @see ThreadRepo */
  pendingSelection(threadId: string): TurnSelection | null {
    return this.threads.pendingSelection(threadId);
  }

  /** @see ThreadRepo */
  clearPendingSelection(threadId: string): void {
    return this.threads.clearPendingSelection(threadId);
  }

  /** Point a session-less placeholder at a selection without a hand-in. @see ThreadRepo */
  retargetThreadSelection(threadId: string, selection: TurnSelection): boolean {
    return this.threads.retargetThreadSelection(threadId, selection);
  }

  /** Remember the knobs that last ran with a provider+model. @see ProviderModelOptionsRepo */
  upsertProviderModelOptions(input: ProviderModelOptionsInput): void {
    return this.providerModelOptions.upsert(input);
  }

  /** What a provider+model last ran with. @see ProviderModelOptionsRepo */
  getProviderModelOptions(provider: ProviderKind, model: string): ProviderModelOptionsRecord | null {
    return this.providerModelOptions.get(provider, model);
  }

  /** Every remembered provider+model, newest first. @see ProviderModelOptionsRepo */
  listProviderModelOptions(): ProviderModelOptionsRecord[] {
    return this.providerModelOptions.list();
  }

  /** Every same-provider model/knob change on a thread, oldest first. @see ModelChangeRepo */
  modelChangesForThread(threadId: string): ModelChangeRecord[] {
    return this.modelChanges.forThread(threadId);
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
  claimQueuedTurn(queueId: string): { row: QueuedTurnRow; from: "queued" | "failed" } | null {
    return this.queuedTurns.claimQueuedTurn(queueId);
  }

  /** @see QueuedTurnRepo */
  isQueuedTurnClaimed(queueId: string): boolean {
    return this.queuedTurns.isQueuedTurnClaimed(queueId);
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
  releaseQueuedTurn(queueId: string, to: "queued" | "failed" = "queued"): boolean | null {
    return this.queuedTurns.releaseQueuedTurn(queueId, to);
  }

  /** Refuse a row a provider switch could not honour. @see QueuedTurnRepo */
  refuseQueuedTurn(queueId: string, reason: string): boolean {
    return this.queuedTurns.refuseQueuedTurn(queueId, reason);
  }

  /** @see QueuedTurnRepo */
  reorderQueuedTurns(threadId: string, queueIds: string[]): boolean {
    return this.queuedTurns.reorderQueuedTurns(threadId, queueIds);
  }

  /** @see QueuedTurnRepo */
  editQueuedTurn(threadId: string, queueId: string, patch: QueuedTurnEditPatch): QueuedTurnRow | null {
    return this.queuedTurns.editQueuedTurn(threadId, queueId, patch);
  }

  /** @see QueuedTurnRepo */
  cancelQueuedTurn(queueId: string, threadId?: string): boolean {
    return this.queuedTurns.cancelQueuedTurn(queueId, threadId);
  }

  /** @see QueuedTurnRepo */
  cancelQueuedTurnsForThread(
    threadId: string,
    only?: readonly string[],
    upTo?: { rowid: number | null; except: readonly string[] },
  ): string[] | null {
    return this.queuedTurns.cancelQueuedTurnsForThread(threadId, only, upTo);
  }

  /** @see QueuedTurnRepo */
  queueBoundary(): number | null {
    return this.queuedTurns.queueBoundary();
  }

  /** @see QueuedTurnRepo */
  listQueuedTurns(threadId: string): QueuedTurnRow[] {
    return this.queuedTurns.listQueuedTurns(threadId);
  }

  /** @see QueuedTurnRepo */
  pendingQueueIds(threadId: string): string[] | null {
    return this.queuedTurns.pendingQueueIds(threadId);
  }

  /** @see AgentInboxRepo */
  insertInboxMessage(input: InboxInsert): InboxInsertResult {
    return this.agentInbox.insertInboxMessage(input);
  }

  /** @see AgentInboxRepo */
  claimInbox(recipientThreadId: string, limit: number, which: InboxRing): InboxClaim | null {
    return this.agentInbox.claimInbox(recipientThreadId, limit, which);
  }

  /** @see AgentInboxRepo */
  settleInboxDelivery(deliveryId: string, turnId: string | null): number | null {
    return this.agentInbox.settleInboxDelivery(deliveryId, turnId);
  }

  /** @see AgentInboxRepo */
  releaseInboxDelivery(deliveryId: string): number | null {
    return this.agentInbox.releaseInboxDelivery(deliveryId);
  }

  /** @see AgentInboxRepo */
  markInboxSending(deliveryId: string): boolean {
    return this.agentInbox.markInboxSending(deliveryId);
  }

  /** @see AgentInboxRepo */
  listUncertainInbox(recipientThreadId: string): InboxRow[] {
    return this.agentInbox.listUncertainInbox(recipientThreadId);
  }

  /** @see AgentInboxRepo */
  linkInboxDelivery(deliveryId: string, turnId: string): boolean {
    return this.agentInbox.linkInboxDelivery(deliveryId, turnId);
  }

  /** @see AgentInboxRepo */
  setInboxBlockId(inboxId: string, blockId: string): void {
    this.agentInbox.setInboxBlockId(inboxId, blockId);
  }

  /** @see AgentInboxRepo */
  markInboxSeen(inboxIds: readonly string[], via: InboxSeenVia, turnId?: string | null): string[] {
    return this.agentInbox.markInboxSeen(inboxIds, via, turnId);
  }

  /** @see AgentInboxRepo */
  retractInboxMessage(inboxId: string): boolean {
    return this.agentInbox.retractInboxMessage(inboxId);
  }

  /** @see AgentInboxRepo */
  listUnseenInbox(recipientThreadId: string, limit?: number): InboxRow[] {
    return this.agentInbox.listUnseenInbox(recipientThreadId, limit);
  }

  /** @see AgentInboxRepo */
  listWaitingInbox(recipientThreadId: string): InboxRow[] {
    return this.agentInbox.listWaitingInbox(recipientThreadId);
  }

  /** @see AgentInboxRepo */
  inboxHistory(recipientThreadId: string, limit: number): InboxRow[] {
    return this.agentInbox.inboxHistory(recipientThreadId, limit);
  }

  /** @see AgentInboxRepo */
  unseenInboxCount(recipientThreadId: string, which?: InboxRing): number {
    return this.agentInbox.unseenInboxCount(recipientThreadId, which);
  }

  inboxMessage(inboxId: string): InboxRow | null {
    return this.agentInbox.inboxMessage(inboxId);
  }

  /** @see AgentInboxRepo */
  sentInbox(senderThreadId: string, query: SentInboxQuery): InboxRow[] {
    return this.agentInbox.sentInbox(senderThreadId, query);
  }

  /** @see AgentInboxRepo */
  unacknowledgedCounts(senderThreadId: string): Map<string, number> {
    return this.agentInbox.unacknowledgedCounts(senderThreadId);
  }

  /** @see ThreadRepo.moveBlockToEnd */
  moveBlockToEnd(threadId: string, blockId: string): void {
    this.threads.moveBlockToEnd(threadId, blockId);
  }

  /** Who wrote one of a thread's user blocks: `{ kind: "user" }` for the
   *  user's own words, null when there is no such block. */
  userBlockSender(threadId: string, blockId: string): MessageSender | null {
    return this.threads.userBlockSender(threadId, blockId);
  }

  /** @see ThreadRepo */
  userBlockAttachments(threadId: string, blockId: string): ChatAttachment[] | undefined {
    return this.threads.userBlockAttachments(threadId, blockId);
  }

  /** @see AgentInboxRepo.onChanged */
  onInboxChanged(listener: InboxChangeListener): () => void {
    return this.agentInbox.onChanged(listener);
  }

  /** @see AgentInboxRepo */
  resetInboxHandingAtBoot(): void {
    this.agentInbox.resetHandingAtBoot();
  }

  /** @see AgentGrantRepo */
  setAgentGrant(grant: AgentGrant): boolean {
    return this.agentGrants.setAgentGrant(grant);
  }

  /** @see AgentGrantRepo */
  revokeAgentGrant(granteeThreadId: string, targetThreadId: string): boolean {
    return this.agentGrants.revokeAgentGrant(granteeThreadId, targetThreadId);
  }

  /** @see AgentGrantRepo */
  agentGrant(granteeThreadId: string, targetThreadId: string): AgentGrant | null {
    return this.agentGrants.agentGrant(granteeThreadId, targetThreadId);
  }

  /** @see AgentGrantRepo */
  agentGrantsOn(targetThreadId: string): AgentGrant[] {
    return this.agentGrants.agentGrantsOn(targetThreadId);
  }

  /** @see AgentGrantRepo */
  agentGrantsHeldBy(granteeThreadId: string): AgentGrant[] {
    return this.agentGrants.agentGrantsHeldBy(granteeThreadId);
  }

  /** @see ThreadTaskRepo */
  threadTaskList(threadId: string): KoneTaskList | null {
    return this.threadTasks.threadTaskList(threadId);
  }

  /** @see ThreadTaskRepo */
  writeThreadTasks(threadId: string, change: (current: ThreadTasksDraft) => ThreadTasksDraft): KoneTaskList | null {
    return this.threadTasks.writeThreadTasks(threadId, change);
  }

  /** @see CrewBoardRepo */
  createCrewBoard(board: Omit<CrewBoard, "revision" | "updatedAt">): CrewBoard | null {
    return this.crewBoards.createCrewBoard(board);
  }

  /** @see CrewBoardRepo */
  crewBoard(boardId: string): CrewBoard | null {
    return this.crewBoards.crewBoard(boardId);
  }

  /** @see CrewBoardRepo */
  crewBoardsFor(threadId: string, projectPath: string): CrewBoard[] {
    return this.crewBoards.crewBoardsFor(threadId, projectPath);
  }

  /** @see CrewBoardRepo */
  crewBoardsInProject(projectPath: string): CrewBoard[] {
    return this.crewBoards.crewBoardsInProject(projectPath);
  }

  /** @see CrewBoardRepo */
  setBoardMember(member: Omit<BoardMember, "rulesSeenRevision">): boolean {
    return this.crewBoards.setBoardMember(member);
  }

  /** @see CrewBoardRepo */
  removeBoardMember(boardId: string, threadId: string): boolean {
    return this.crewBoards.removeBoardMember(boardId, threadId);
  }

  /** @see CrewBoardRepo */
  boardMember(boardId: string, threadId: string): BoardMember | null {
    return this.crewBoards.boardMember(boardId, threadId);
  }

  /** @see CrewBoardRepo */
  boardMembers(boardId: string): BoardMember[] {
    return this.crewBoards.boardMembers(boardId);
  }

  /** @see CrewBoardRepo */
  markBoardRulesSeen(boardId: string, threadId: string, revision: number): void {
    this.crewBoards.markBoardRulesSeen(boardId, threadId, revision);
  }

  /** @see CrewBoardRepo */
  writeBoardBrief(boardId: string, brief: string, expectedRevision: number): BoardWrite<CrewBoard> {
    return this.crewBoards.writeBoardBrief(boardId, brief, expectedRevision);
  }

  /** @see CrewBoardRepo */
  writeBoardRule(
    input: { boardId: string; ruleId: string; text: string; retired?: boolean },
    expectedRevision: number,
  ): BoardWrite<BoardRule> {
    return this.crewBoards.writeBoardRule(input, expectedRevision);
  }

  /** @see CrewBoardRepo */
  boardRules(boardId: string): BoardRule[] {
    return this.crewBoards.boardRules(boardId);
  }

  /** @see CrewBoardRepo */
  writeBoardRow(row: Omit<BoardRow, "revision" | "updatedAt">, expectedRevision: number | null): BoardWrite<BoardRow> {
    return this.crewBoards.writeBoardRow(row, expectedRevision);
  }

  /** @see CrewBoardRepo */
  boardRows(boardId: string): BoardRow[] {
    return this.crewBoards.boardRows(boardId);
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

  /** @see TurnRollbackRepo */
  markTurnsRolledBack(threadId: string, fromTurnId: string, at?: number): string[] {
    return this.turnRollbacks.markTurnsRolledBack(threadId, fromTurnId, at);
  }

  /** @see TurnRollbackRepo */
  rolledBackTurnIds(threadId: string): Set<string> {
    return this.turnRollbacks.rolledBackTurnIds(threadId);
  }

  /** @see TurnRollbackRepo */
  isTurnRolledBack(threadId: string, turnId: string): boolean {
    return this.turnRollbacks.isTurnRolledBack(threadId, turnId);
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
  allThreadWorkspaces(): Array<{
    threadId: string;
    projectPath: string;
    workspace: ThreadWorkspace;
  }> {
    return this.workspaces.allThreadWorkspaces();
  }

  /** The background work a restart cancelled, captured at the boot seal,
   *  grouped by thread. Read-once. @see ConversationDb */
  takeRestartCancelledBackgroundWork(): Map<string, RestartCancelledBackgroundWork[]> {
    return this.dbh.takeRestartCancelledBackgroundWork();
  }

  /** @see ContinuationRepo */
  scheduleContinuation(
    input: Parameters<ContinuationRepo["schedule"]>[0],
  ): ContinuationRecord | null {
    return this.continuations.schedule(input);
  }

  /** @see ContinuationRepo */
  claimDueContinuations(now: number, excludedContinuationIds: string[] = []): ContinuationRecord[] {
    return this.continuations.claimDue(now, excludedContinuationIds);
  }

  /** @see ContinuationRepo */
  getContinuation(continuationId: string): ContinuationRecord | null {
    return this.continuations.getContinuation(continuationId);
  }

  /** @see ContinuationRepo */
  failContinuation(continuationId: string, nextDueAt: number): number {
    return this.continuations.fail(continuationId, nextDueAt);
  }

  /** @see ContinuationRepo */
  releaseOrphanedContinuationClaims(): void {
    this.continuations.releaseOrphanedClaims();
  }

  /** @see ContinuationRepo */
  clearContinuationClaim(continuationId: string): void {
    this.continuations.clearClaim(continuationId);
  }

  /** @see ContinuationRepo */
  deleteContinuation(continuationId: string): void {
    this.continuations.deleteContinuation(continuationId);
  }

  /** Drop a thread's unclaimed continuations. @see ContinuationRepo */
  cancelContinuationsForThread(threadId: string): number {
    return this.continuations.cancelForThread(threadId);
  }

  /** @see ContinuationRepo */
  nextContinuationDueAt(excludedContinuationIds: string[] = []): number | null {
    return this.continuations.nextDueAt(excludedContinuationIds);
  }

  /** @see ContinuationRepo */
  listContinuationsForThread(threadId: string): ContinuationRecord[] {
    return this.continuations.listForThread(threadId);
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

  /** @see WorkspaceRepo */
  idleWorktrees(
    cutoff: number,
    limit: number,
  ): IdleWorktree[] {
    return this.workspaces.idleWorktrees(cutoff, limit);
  }

  /** @see WorkspaceRepo */
  detachWorktree(worktreePath: string, branch: string): void {
    this.workspaces.detachWorktree(worktreePath, branch);
  }

  /** @see WorkspaceRepo */
  worktreeHasOtherLiveThreads(worktreePath: string, exceptThreadId: string): boolean {
    return this.workspaces.worktreeHasOtherLiveThreads(worktreePath, exceptThreadId);
  }

  /** @see WorkspaceRepo */
  worktreeCleanupDays(): number | null {
    return this.workspaces.worktreeCleanupDays();
  }

  /** @see WorkspaceRepo */
  setWorktreeCleanupDays(days: number | null): void {
    this.workspaces.setWorktreeCleanupDays(days);
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

  /** @see ThreadRepo */
  turnUserBlockId(threadId: string, turnId: string): string | null {
    return this.threads.turnUserBlockId(threadId, turnId);
  }

  /** @see TranscriptRepo */
  loadThread(threadId: string): StoredThread | null {
    return this.transcript.loadThread(threadId);
  }

  /** @see TranscriptRepo */
  titleMessages(threadId: string): import("./threadTitleContext.js").ThreadTitleMessage[] {
    return this.transcript.titleMessages(threadId);
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
  conversationIdsForProject(projectPath: string): Set<string> {
    return this.stats.conversationIdsForProject(projectPath);
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

  /** @see TranscriptRepo */
  hasSettledAssistantTurn(threadId: string): boolean {
    return this.transcript.hasSettledAssistantTurn(threadId);
  }

  /** @see LineageRepo */
  threadForkContext(threadId: string): ForkContext | null {
    return this.lineage.threadForkContext(threadId);
  }

  /** Every continuation forked from a source thread, oldest first. @see LineageRepo */
  continuationsFromSource(sourceThreadId: string): ContinuationLink[] {
    return this.lineage.continuationsFromSource(sourceThreadId);
  }

  /** Record that a thread changed hands and retarget its row. @see HandInsRepo */
  writeHandIn(input: Parameters<HandInsRepo["writeHandIn"]>[0]): HandInRecord | null {
    return this.handIns.writeHandIn(input);
  }

  /** Every time this thread changed hands, oldest first. @see HandInsRepo */
  handInsForThread(threadId: string): HandInRecord[] {
    return this.handIns.handInsForThread(threadId);
  }

  /** The hand-in still waiting to bootstrap its new session. @see HandInsRepo */
  pendingHandIn(threadId: string): HandInRecord | null {
    return this.handIns.pendingHandIn(threadId);
  }

  /** Record the ids a hand-in's one-shot replay omitted. @see HandInsRepo */
  recordHandInOmittedHistory(
    threadId: string,
    omittedBlockIds: readonly string[],
    omittedItemIds: readonly string[],
  ): void {
    this.handIns.recordHandInOmittedHistory(threadId, omittedBlockIds, omittedItemIds);
  }

  /** Record the ids a fork's one-shot replay omitted. @see LineageRepo */
  recordForkOmittedHistory(
    threadId: string,
    omittedBlockIds: readonly string[],
    omittedItemIds: readonly string[],
  ): void {
    this.lineage.recordForkOmittedHistory(threadId, omittedBlockIds, omittedItemIds);
  }

  /** @see LineageRepo */
  writeForkThread(input: Parameters<LineageRepo["writeForkThread"]>[0]): boolean {
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
    contract?: ContractTerms;
  }): boolean {
    return this.lineage.writeSpawnedThread(input);
  }

  /** @see LineageRepo */
  retargetSpawnedThread(threadId: string, provider: ProviderKind, model?: string): void {
    return this.lineage.retargetSpawnedThread(threadId, provider, model);
  }

  /** @see LineageRepo */
  setContractClosed(threadId: string, closed: { at: number; reason: ContractClosedReason } | null): boolean {
    return this.lineage.setContractClosed(threadId, closed);
  }

  threadLineage(threadId: string): ThreadLineage | null {
    return this.lineage.threadLineage(threadId);
  }

  /** @see LineageRepo */
  spawnedChildren(parentThreadId: string): StoredThreadMeta[] {
    return this.lineage.spawnedChildren(parentThreadId);
  }

  /** @see LineageRepo */
  spawnedChildrenPage(parentThreadId: string, options?: SpawnedChildrenPageOptions): SpawnedChildrenPage {
    return this.lineage.spawnedChildrenPage(parentThreadId, options);
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
  turnAssistantText(threadId: string, turnId: string): string | null {
    return this.transcript.turnAssistantText(threadId, turnId);
  }

  /** @see TranscriptRepo */
  turnAssistantUuid(threadId: string, turnId: string): string | null {
    return this.transcript.turnAssistantUuid(threadId, turnId);
  }

  /** @see TranscriptRepo */
  threadTurnSpan(threadId: string): TurnSpan | null {
    return this.transcript.threadTurnSpan(threadId);
  }

  /** @see TranscriptRepo */
  turnSpan(threadId: string, turnId: string): TurnSpan | null {
    return this.transcript.turnSpan(threadId, turnId);
  }

  /** @see TranscriptRepo */
  sealTurn(threadId: string, turnId: string, seal: TurnSeal): boolean {
    return this.transcript.sealTurn(threadId, turnId, seal);
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

  /** @see JobRepo */
  createJob(input: JobCreateInput): JobRow | null {
    return this.jobs.createJob(input);
  }

  /** @see JobRepo */
  getJob(jobId: string): JobRow | null {
    return this.jobs.getJob(jobId);
  }

  /** @see JobRepo */
  listJobs(projectPath: string): JobRow[] {
    return this.jobs.listJobs(projectPath);
  }

  listAllJobs(): JobRow[] {
    return this.jobs.listAllJobs();
  }

  /** @see JobRepo */
  updateJob(jobId: string, patch: JobPatch, at?: number): JobRow | null {
    return this.jobs.updateJob(jobId, patch, at);
  }

  /** @see JobRepo */
  setJobQueued(jobId: string, queued: boolean, at?: number): JobRow | null {
    return this.jobs.setJobQueued(jobId, queued, at);
  }

  /** @see JobRepo */
  requeueJob(jobId: string, at?: number): JobRow | null {
    return this.jobs.requeueJob(jobId, at);
  }

  /** @see JobRepo */
  reorderJobs(projectPath: string, jobIds: readonly string[], at?: number): boolean {
    return this.jobs.reorderJobs(projectPath, jobIds, at);
  }

  /** @see JobRepo */
  deleteJob(jobId: string): boolean {
    return this.jobs.deleteJob(jobId);
  }

  createSchedule(input: ScheduleCreateInput): ScheduleRow | null { return this.schedules.createSchedule(input); }
  getSchedule(id: string): ScheduleRow | null { return this.schedules.getSchedule(id); }
  listSchedules(projectPath?: string): ScheduleRow[] { return this.schedules.listSchedules(projectPath); }
  updateSchedule(id: string, patch: SchedulePatch, at?: number): ScheduleRow | null { return this.schedules.updateSchedule(id, patch, at); }
  pauseSchedule(id: string, at?: number): ScheduleRow | null { return this.schedules.pauseSchedule(id, at); }
  resumeSchedule(id: string, at?: number): ScheduleRow | null { return this.schedules.resumeSchedule(id, at); }
  deleteSchedule(id: string): boolean { return this.schedules.deleteSchedule(id); }
  runNow(id: string, at?: number): { job: JobRow | null; reason?: string } { return this.schedules.runNow(id, at); }
  fireDueSchedules(now: number, graceMs?: number, deferredScheduleIds?: readonly string[]): ScheduleFireResult { return this.schedules.fireDue(now, graceMs, deferredScheduleIds); }

  /** @see JobRepo */
  claimNextJob(input: {
    projectPath: string;
    claimedBy: string;
    at?: number;
    leaseMs?: number;
    runId?: string;
  }): ClaimedJob | null {
    return this.jobs.claimNextJob(input);
  }

  /** @see JobRepo */
  bindRunThread(runId: string, threadId: string, at?: number): JobRunRow | null {
    return this.jobs.bindRunThread(runId, threadId, at);
  }

  /** @see JobRepo */
  releaseJobClaim(runId: string, error: string, at?: number): boolean {
    return this.jobs.releaseClaim(runId, error, at);
  }

  /** @see JobRepo */
  settleJobRun(runId: string, outcome: JobRunOutcome, at?: number): JobRunRow | null {
    return this.jobs.settleRun(runId, outcome, at);
  }

  /** @see JobRepo */
  getJobRun(runId: string): JobRunRow | null {
    return this.jobs.getJobRun(runId);
  }

  /** @see JobRepo */
  listJobRuns(jobId: string): JobRunRow[] {
    return this.jobs.listJobRuns(jobId);
  }

  /** @see JobRepo */
  sweepExpiredJobClaims(at?: number): number {
    return this.jobs.sweepExpiredClaims(at);
  }

  /** @see JobRepo */
  getJobRunByThread(threadId: string): JobRunRow | null {
    return this.jobs.getJobRunByThread(threadId);
  }

  /** @see JobRepo */
  projectsWithQueuedJobs(): string[] {
    return this.jobs.projectsWithQueuedJobs();
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

  /** @see ModelPreferenceRepo */
  listModelPreferences(): ModelPreference[] {
    return this.modelPreferences.listModelPreferences();
  }

  /** @see ModelPreferenceRepo */
  saveModelPreferences(list: readonly ModelPreference[]): ModelPreference[] | null {
    return this.modelPreferences.saveModelPreferences(list);
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
  bindThreadAgent(
    threadId: string,
    agentId: string | null,
    route?: ThreadAgentRoute | null,
  ): ThreadAgentBinding | null {
    return this.roster.bindThreadAgent(threadId, agentId, route);
  }

  /** @see RosterRepo */
  carryThreadAgent(
    fromThreadId: string,
    toThreadId: string,
    withRoute = false,
  ): ThreadAgentBinding | null {
    return this.roster.carryThreadAgent(fromThreadId, toThreadId, withRoute);
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
export type { ModelPreference } from "./modelPreference.js";
export * from "./conversationStoreTypes.js";
export * from "./conversationWire.js";

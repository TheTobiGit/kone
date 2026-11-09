# Rune backend audit

This audit covers project navigation, project overview, and Studio conversations. Settings, space, file and Git views, and portals are outside this phase. Paths below refer to this repository unless stated otherwise.

## Existing boundaries

- `packages/agent-core` contains `AgentService`, provider adapters, `ConversationStore`, dispatcher, provider discovery, attachment storage, event types, migrations, and the runtime wire projection. It accepts the host's data directory through `setUserDataDir` and is not inherently tied to Electron.
- `apps/desktop/src/agent/agent-ipc.ts` is more than a list of IPC calls: it initializes the dispatcher and its workspace capabilities, forwards service events, sets up subscriptions, pending interaction replay, gateway, cleanup, and other lifecycle services. Extract a host-neutral bootstrap from it rather than creating a second partial service implementation. Omitted views do not imply deleting capabilities needed by Studio, e.g. worktree provisioning or approval handling.
- `apps/desktop/src/modules/studio/ipc.ts` maps layout load/save to `ConversationStore.loadStudio/saveStudio`. `store/studio.ts` stores a version-2 layout in SQLite `app_state`.
- `apps/web/app/composables/useRecentProjects.ts` owns the recent list in renderer localStorage (`kone:recent-projects`), not SQLite. Entries include project fields, `lastOpenedAt`, and optional `pinned`; deduplicate by path, retain pins when reopening, cap at 24, display pins first and then recency. Native storage needs an explicit import path if existing Electron recents are to appear. Do not silently assume an Electron localStorage directory or mutate it.
- Project overview can reuse the host-independent read functions in `apps/desktop/src/modules/git/about.ts` and `@kone/git-core`; the overview may need repository metadata even though the Git view is excluded. Audit its actual Vue component calls when implementing.

## Runtime and persistence constraint

`packages/agent-core/src/sqlite.ts` imports `node:sqlite`. On this machine Bun 1.2.16 fails to resolve that module, verified with an in-memory `DatabaseSync` import. A Bun sidecar cannot run the real store unchanged on this runtime. Choose either a packaged Node version supporting `node:sqlite` and TypeScript/build dependencies, or a SQLite driver compatibility layer tested against the entire migration and store suite. Validate the chosen distribution with the packaged app, not only dev. Provider SDKs and native dependencies also need packaging verification.

`ConversationDb.handle()` opens `kone.sqlite` with WAL and executes migrations and recovery that seals supposedly orphaned turns and releases claims. Its recovery assumes no other live owner. Concurrent Electron and Rune processes sharing this data directory could corrupt live state semantically even though SQLite locking protects individual writes. Develop and test against a temporary or Rune-specific directory. Before importing production history, define a single-owner policy and a backed-up migration/copy procedure, including SQLite WAL and attachments; avoid copying an active database by ordinary file copy. Existing schema compatibility alone does not establish safe concurrent operation.

## Suggested sidecar protocol

Use a supervised child process with newline-delimited JSON-RPC 2.0 on stdin/stdout, with logs exclusively on stderr. The parent assigns request IDs, resolves or rejects pending calls on exit, handles partial lines and bounded frames, and surfaces startup/disconnect failures. Negotiate a protocol version and capabilities at initialization. No unauthenticated network listener is necessary for a single local child. Existing `packages/agent-core/src/jsonRpc.ts` demonstrates request IDs, notifications, exit handling, and bidirectional requests for provider processes; it is a client, not a ready-made sidecar server.

Build the first RPC set around existing types and return values, preserving their semantics:

| Area | Operations / implementation |
| --- | --- |
| Lifecycle | initialize with explicit data directory, version/capabilities; graceful shutdown that stops sessions and child processes. |
| Projects | list, remember, forget, pin in native-owned persistent storage; native folder picker supplies paths. Optional overview reads use `git/about.ts` and git-core. |
| Studio | `studio.load` and `studio.save` using the existing version-2 layout contract. |
| Providers | surface/warm/discover/models via `AgentService` so the composer can choose an installed CLI and model. |
| Conversations | start and send through `initThreadDispatcher`, interrupt and stop through `AgentService`; list/latest/thread/page via `ConversationStore` and `conversationWire.ts` projections. Preserve request IDs, thread IDs, working directory and provider session IDs from `types.ts`. |
| Interaction | approval and user-input responses by thread/request ID; queue and steer, if exposed by the Studio composer. Re-present outstanding asks on a client resubscription. |
| Events | forward projected `RuntimeEvent` notifications, preserving ordering, item replacement and lifecycle boundaries. `EventSubscriptions` batches high-frequency item updates but sends approvals immediately. |

Transport success is not turn completion: dispatcher calls acknowledge work and actual status comes from runtime events. Subscribe before taking a history snapshot, buffer events while hydrating, then reconcile by item/event identity so an event between snapshot and subscription is not lost. Rehydrate from stored pages after sidecar restart; parked approvals are in memory and need the service's `pendingInteractions()` replay while that service remains alive. A sidecar crash must reject pending calls and report interrupted sessions; database recovery runs on the next process open.

Reference implementation checks: `~/Developer/opensource/t3code/apps/server/src/utils/subscribeBeforeSnapshot.ts` shows how to attach a subscription before an uncoordinated snapshot; `~/Developer/opensource/synara/apps/server/src/wsRpc.ts` uses snapshot/cursor/replay and explicitly handles resnapshot conditions. These support designing the race boundary; kone's existing store and event shapes remain the source of truth.

## Verification milestones

1. Start/stop the packaged sidecar with a fresh temporary data directory; test malformed frames, concurrent requests, stderr logging, abrupt exit and restart.
2. Run migrations/store tests against the selected SQLite runtime; verify the entire Studio layout round trip and conversation rehydration across a restart.
3. Use a controlled fake provider to test ordered streaming, interruption, approval/question response and reconnection during a turn; then smoke-test an installed provider with an isolated temporary project.
4. Exercise project list add/reopen/pin/remove and overview reads, then compare against the Electron app. Verify production-data migration only on disposable copies before enabling it.

# Phase 4 first review — CHANGES

Branch: `p4-forks`. Exact reviewed commit: `5c88bce7fa1c3d23b0b0dd6b8b939329355f3495` (`5c88bce7`). Base: `6a4bac3c`. Worktree: `/home/gideonsarfo/Developer/kone-wt/p4-forks`. Verified the requested tip and branch before reviewing; tracked tree remains clean. Reviewed the whole range, including migrations 32–33, IPC/preload, renderer type mirror, store, adapters, dispatcher, fork/merge-back tools and their tests. No implementation fixes made.

Verdict: **CHANGES**. The native-fork startup and rollback-refusal requirements are not satisfied through production entry points.

All source locations below are relative to this pinned worktree. Repro files are review artifacts outside the source tree. Their tests deliberately assert the observed defective behavior: a passing repro confirms the defect, rather than asserting the desired future behavior.

## Findings

### F1 — P1 / high: normal session startup loses native fork history

Location: `packages/agent-core/src/dispatch.ts:559` (fork injection exists only in `ensureThreadSession`), with `threadFork.ts:150` and `threadFork.ts:170` (bootstrap completed and no imported blocks).

Scenario: fork a finished Codex turn with a saved native conversation, then start the fork through `agent:start-session`, which invokes `dispatcher.startThread` directly (`apps/desktop/src/agent/agent-ipc.ts:737`). `startThread` forwards the caller's input without looking up the saved native fork. Neither `forkFrom` nor `resume` reaches the adapter. The adapter starts an empty conversation. Portable bootstrap is already disabled and there are no imported blocks, so the first user message has none of the source history. This is also the ordinary session-start contract used after conversation-only rewind.

Repro: `reviews/p4-forks-5c88bce7.repro.test.ts`, test **F1 normal startThread drops native fork and portable replay is disabled**. It creates a native fork against a real store, invokes the dispatcher entry point, and verifies absent fork/resume input and absent portable context. Resolve the native target at the common start entry point, while respecting the provider chosen for that start.

### F2 — P1 / high: choosing another provider still uses the source's native pointer

Location: `packages/agent-core/src/threadFork.ts:76`, `threadFork.ts:143`, and `packages/agent-core/src/dispatch.ts:559`.

Scenario: fork a Codex source with `target.provider = claudeAgent` (accepted by the gateway), then start with `ensureThreadSession`. Native eligibility is based on the source capability, without requiring the chosen provider to match. The fork has zero imported history, and the dispatcher hands Codex's conversation/turn pointer to Claude's `forkSession`. Startup fails on a foreign/missing session; a provider without a native-fork handler instead starts blank. The same missing portable history affects changing the provider on the first message after creation. This violates the first-message provider choice and portable fallback requirements independently of F1.

Repro: `reviews/p4-forks-5c88bce7.repro.test.ts`, test **F2 native fork passes Codex conversation to chosen Claude provider**. It verifies the actual dispatcher passes `provider: claudeAgent` together with a Codex `beforeTurnId` pointer and that portable bootstrap is unavailable. A differing provider must use preserved portable history rather than the foreign native pointer.

### F3 — P1 / high: real file restores never stamp rolled-back turns

Location: `packages/agent-core/src/ConversationStore.ts:492` and the new refusal at `packages/agent-core/src/threadFork.ts:66`; successful restore returns at `AgentService.ts:1823` without calling the stamp writer.

Scenario: two completed turns change files; successfully restore the first turn's pre-turn checkpoint, then fork that turn or a later discarded turn. `markTurnsRolledBack` is only called by tests: no production restore invokes it. The new table remains empty, so both fork and conversation-only rewind accept turns whose file work was undone. Merely testing the refusal after manually inserting stamps does not exercise the real path. The supplied P2 fix does not provide this production wiring either.

Repro: `reviews/p4-forks-5c88bce7.repro.test.ts`, test **F3 real successful restore leaves turn forkable**. Uses a real temporary Git repo, real checkpoint/restore, real store and service: file changes from `after` to `before`, restore returns `ok: true`, rollback query remains false, and fork succeeds. Wire verified successful restores to stamp the boundary turn and all later turns; refusal/failure must not stamp them.

### F4 — P2 / medium: gateway bypasses the in-flight source refusal

Location: `packages/agent-core/src/gateway/tools/appForks.ts:56` and `packages/agent-core/src/threadFork.ts:49`.

Scenario: a source adapter has accepted a send call but has not emitted `turn.started`. The service already reports that source busy, but its persisted assistant blocks are all settled. `app_fork_thread` calls the data function directly, whose only running check examines those blocks. It successfully creates a fork while the source has work in flight. The conversation-only service entry point correctly refuses the identical source. Use the service's busy state at the gateway boundary as well.

Repro: `reviews/p4-forks-5c88bce7.repro.test.ts`, test **F4 gateway accepts a source with dispatch in flight before turn.started**. Holds a real service's adapter send pending, confirms `isThreadBusy` and rewind refusal, then verifies success through the production `target: assistant` mapping.

### F5 — P1 / high: Claude fork publishes a resume cursor absent from its own transcript

Location: `packages/agent-core/src/adapters/ClaudeAdapter.ts:507`, propagated by `ClaudeAdapter.ts:2178` and persisted by `store/events.ts:154`.

Scenario: start a native Claude fork, then interrupt/close/crash before it produces its first assistant message, and reopen it. SDK `forkSession` copies the transcript with fresh message UUIDs (the installed SDK contract in `sdk.d.ts:817–843` explicitly describes remapping). The adapter nevertheless initializes `lastAssistantUuid` with the **source** UUID. Lifecycle events persist that source UUID as the fork's resume cursor. Reopening supplies the fork session id and a cursor that cannot exist in that session. Resume fails or falls back to a fresh conversation, and the no-import/completed-bootstrap fork cannot reconstruct its history. Preserve or discover a fork-local cursor instead of publishing the source cursor after copying.

Repro: `reviews/p4-forks-5c88bce7.claude-repro.test.ts`, test **F5 fork session publishes its source UUID as a resume cursor even though forkSession remaps UUIDs**. The SDK is stubbed, the real adapter starts the fork, and its emitted lifecycle event carries the source UUID. The SDK remapping itself is supported by the precise installed SDK contract/code, not a live provider run.

### F6 — P2 / medium: optional thread-id path cannot replay its own idempotency key

Location: `packages/agent-core/src/gateway/tools/appForks.ts:46`.

Scenario: call `app_fork_thread` with required `requestId` and omit optional `threadId`; retry the identical call after a lost response. The handler mints another thread id before checking the request binding. The store throws an idempotency conflict instead of returning the previously created fork and its id. Thus the required idempotency key cannot recover the result on the advertised default creation path. Resolve an existing request binding before minting an id.

Repro: `reviews/p4-forks-5c88bce7.repro.test.ts`, test **gateway retry without threadId conflicts with its own requestId**; goes through `target: assistant` and verifies the second identical request is an `isError` conflict.

## P2 interaction and additional checks

- Real prompt id plus an assistant block: cuts through the turn's last assistant block, not at the prompt. Null plus an assistant block uses the same correct boundary. Later turns are omitted. Does not depend on P2's `turnUserBlockId` lookup.
- No assistant block plus a real prompt id: imports through that prompt. No assistant block plus null: refuses as “That turn is not part of this conversation”; no arbitrary earlier/later answer is used. There is no identifiable block boundary in that input. Basalt confirmed that a clear refusal is acceptable here. The updated boundary repro verifies `isError` assistant-target text names the turn and reason, neither gateway nor service writes a fork, and neither creates a live session. No additional finding. `store/events.ts:189` durably creates an assistant block on `turn.started`; started turns with no answer text still have that block, and the failed/interrupted/cancelled repros successfully fork them with null prompt ids. No valid persisted started turn was found reaching the missing-boundary branch.
- Completed, failed, interrupted and cancelled turns fork via portable context. A synthetic future `limited` abort is accepted by the generic store/fork path; P3's actual limited integration is not present on this pin.
- A running persisted assistant block is refused; manual rollback stamps refuse forks. The production stamp and gateway in-flight gaps are F3/F4.
- Creation itself starts no session and sends no turn. A Claude native target can be passed to startup after its source is rollback-stamped, because the fork stores its own target; native usability is limited by F1/F5 and was not verified live. P2's file-only restore does not truncate the native conversation.
- Merge-back writes a system-attributed user block naming the fork, updates searchable transcript through `recordUserBlock`, and broadcasts `thread.message-journaled`; assistant-target tool text includes both thread ids and the new block id. Refusals are `isError` text.
- Migrations 32 and 33 were run as independent manifest functions on schema 31, then rerun. Checked table/column creation, retained rollback rows and cascading deletion. No finding on those migrations. They still need renumbering to 34/35 at integration per the lead's decision.

## Verification and gates

Bun on this Linux machine is `/home/gideonsarfo/.local/bin/bun`, version 1.4.2; `~/.bun/bin/bun` is absent. Individual targeted files were run directly as permitted by RULES.md.

Review-only repros: **9/0** in `reviews/p4-forks-5c88bce7.repro.test.ts` and **1/0** in `reviews/p4-forks-5c88bce7.claude-repro.test.ts`. Outputs: the adjacent `.repro.log` and `.claude-repro.log`. Re-run each with `~/.local/bin/bun test <absolute test path>` from the pinned worktree. Existing targeted files: `threadFork.test.ts` **14/0**, `rewindConversationOnly.test.ts` **5/0**, `gateway/tools/appForks.test.ts` **10/0**, `mergeBack.test.ts` **2/0**. `git diff --check 6a4bac3c..5c88bce7` passes.

Read the pinned gate logs at `/home/gideonsarfo/Developer/kone-wt/gates/5c88bce7-p4-forks-<step>.log`:

| Step | Exit | Result |
| --- | --- | --- |
| types | 0 | Mac gate |
| lint | 0 | Mac gate; one unused-disable warning |
| agent-core | 0 | 2763/0 |
| protocol | 0 | 124/0 |
| git-core | 0 | 73/0 |
| web | 0 | 1498/0 |
| desktop | 0 | Current log shows 430/0; supplied original run was 429/1 known prDetail timeout |
| build | 0 | Linux retry: desktop cached, web built fresh; `NODE_OPTIONS=--max-old-space-size=4096`; 4m34.974s |

The first Linux build log is preserved as `reviews/p4-forks-5c88bce7.build-first.log` (web manifest ENOENT; desktop build completed). Basalt's completed retry owns the canonical build log (`# exit=0`), confirmed by the gate ledger at 2026-10-10T18:08:40Z. My duplicate gate was cancelled while waiting for the lock (ledger exit 143); it never executed a build and is not a build-test failure. The successful Linux retry is verified. Per Basalt, the first ENOENT was an environmental race between web and desktop building into shared `apps/web/node_modules/.cache/nuxt`; the P6 tip built both uncached in parallel successfully. The first failure is recorded separately and is not an additional P4 source finding.

## Not checked / not done

Native forks are **unit-tested only**: no live Codex `thread/fork`, Claude SDK/CLI fork-and-resume, provider truncation/compaction, or paid provider session exercised. No renderer UI behavior reviewed beyond its type mirror and the backend session-start call contract. No P5 implementation reviewed. No other branch changed, no fixes, commits, merges or pushes made. Did not rerun full suites/types/lint; used the pinned gate logs and targeted tests. Actual combined P2/P3/P4 behavior and renumbered migrations require integration gates.

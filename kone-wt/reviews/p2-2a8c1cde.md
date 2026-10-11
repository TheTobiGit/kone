# P2 re-review: CHANGES

Branch: `p2-safety`. Pin: **2a8c1cde76df1cd3e451a2bcf54c6e79a477b54c** (`2a8c1cde`).
Worktree: `/home/gideonsarfo/Developer/kone-wt/p2-safety`.
Verified the short SHA before review and again at completion; tracked worktree remains clean. Scope: all changes in `b37b836e..2a8c1cde`, earlier regression confirmations, and the explicitly requested audit of every direct adapter send/steer call. No tracked changes.

Both findings in p2-b37b836e.md are fixed for their reproduced scenarios. The direct-call audit identifies two further restore-admission holes; therefore the requested confirmation that no remaining direct call can start a turn under a claim cannot be given.

## Findings

### 1. [P1] Failed queue persistence falls back to an unguarded send during a restore

Location: **packages/agent-core/src/AgentService.ts:3025–3027**, reached by the restore queue branch at **1046–1047**.

Scenario: an idle owner is inside a hard checkpoint reset. A user sends a prompt, so sendTurn attempts to queue it behind the restore. The store's enqueue throws, for example on an SQLite write failure. enqueueTurn catches the exception and directly calls adapter.sendTurn, bypassing sendToAdapter's restore check and busy marker. The new prompt is accepted while the checkout is still being reset. Its file reads/edits can race the hard reset, defeating the P2 isolation guarantee.

This is not a hypothetical nonconforming store: **store/queuedTurns.ts:81–116** uses durably/INSERT without catching write exceptions; **store/ConversationDb.ts:208–216** propagates errors from the write. The direct-send fallback predates the latest commit, but the restore-queue admission added earlier exposes it under a live restore claim.

Repro: **/home/gideonsarfo/Developer/kone-wt/reviews/p2-2a8c1cde-enqueue-failure-repro.test.ts:390** and **407**. The first injects a SQLITE_FULL-style enqueue exception. The second uses the real ConversationStore and SQLite connection, adding an aborting INSERT trigger without replacing any store method. Both hold restoreCheckpoint at an await and observe an adapter prompt during the claim, expected none. The real SQLite test's stack runs through queuedTurns.ts:97, ConversationDb.ts:210 and AgentService.ts:3027. Both assertions fail. Command: `bun test <repro-path> -t 'enqueue failure'`. Log: `p2-2a8c1cde-enqueue-failure-repro.log` beside the test, exit 1, 0 pass / 2 fail.

A persistence failure must not bypass restore admission. Refuse without contacting the provider when the required queue cannot be written.

### 2. [P1] An in-flight live steer can become a fresh turn after a restore has claimed the checkout

Location: **packages/agent-core/src/AgentService.ts:2623–2627**, also **2739–2740** for queued Send now's live-steer path. Neither direct steer call retains dispatchingTurns across its asynchronous handoff. Related provider behavior: **adapters/OpenCodeAdapter.ts:730–733**, **675–695**, **711**.

Scenario: the service sees an active turn and calls the provider's steer method. OpenCode awaits prompt/attachment/skill preparation, or a live mode PATCH. During that await the original turn completes. The service's activeTurns entry clears; it holds no dispatchingTurns entry for this steer. runRevert can now pass isBusy at **1752** and claim/reset the checkout. OpenCode resumes its send preparation, rechecks session.activeTurnId at line 711, sees no live turn, emits a fresh turn.started and sends the prompt. That new turn starts inside the existing restore claim.

The new liveOnly/restoreHolds check only protects calls arriving after a restore owns the directory; it does not protect a steer already handed to an adapter when the original turn ends. The service explicitly acknowledges adapters can fall back to fresh turns at **2621–2622** and **2741–2742**, so merely classifying these calls as steering INTO a live turn is insufficient.

Repro: **/home/gideonsarfo/Developer/kone-wt/reviews/p2-2a8c1cde-steer-handoff-repro.test.ts:390**, test `a steer that becomes a fresh turn must keep restore admission closed`. Uses real AgentService event tracking and a gated provider double matching OpenCode's async preparation followed by fresh-turn admission. It begins a live steer, emits the old turn's completion, starts and gates a restore, then resumes the steer as a fresh turn. The provider sends `late steer` while the reset is gated, expected none. The test also accepts a safe implementation that refuses the restore as busy while steering is in flight, and releases all gates before cleanup. Command: `bun test <repro-path> -t 'steer that becomes'`. Log: `p2-2a8c1cde-steer-handoff-repro.log` beside the test, exit 1, 0 pass / 1 fail.

The controlled repro exercises the service race; production reachability is supported by the cited actual OpenCode code. No live OpenCode process or file mutation was exercised. Both service direct-steer paths need an admission marker across a handoff capable of starting a fresh turn, so a restore cannot claim in that interval.

## Direct-call inventory

Searched AgentService.ts for every `.sendTurn(` and `.steerTurn(`:

| Line | Assessment |
|---|---|
| 1034 | No-provider branch: adapterForThread at 600 throws synchronously when routing has no provider, so this expression cannot send. |
| 1381 | Main send: restoreHolds checked at 1374 before dispatchingTurns is set; no await between them. |
| 1439 | Provider failover: still inside sendToAdapter's dispatchingTurns lifetime, cleared only in finally; a restore on this thread cannot pass busy during its fallback awaits. |
| 2003 | Command compaction: new restore check at 1916 runs before synchronous entry into runCompaction and setting its busy marker, before the first await. |
| 2625 | Live steer: asynchronous fresh-turn race, finding 2. |
| 2660 | Service steer fallthrough to sendTurn, covered by ordinary restore queueing and the new liveOnly guard. |
| 2740 | Send now live steer: same handoff race as finding 2. Queue-delivery serialization does not count as isBusy for runRevert. |
| 3027 | Enqueue-error direct send: finding 1. |

## Confirmed fixes and retained checks

- **b37 finding 1, liveOnly steer arriving during restore:** fixed at 2633–2634. It now rejects before queue fallthrough and leaves no row. Plain steers still use sendTurn's restore queue; the guard is conditional on liveOnly.
- **b37 finding 2, compaction starting during restore:** fixed at 1916–1917, after any ensureSession await and before native/command selection. Finally clears the temporary compaction flag. The command-compaction repro now passes; native operations are guarded by the same predicate.
- Committed checkpointRestoreRace tests: **9/0**. Earlier external extra restore repro: **10/0**, including both last-round findings and repeated-kick serialization.
- Restart ownership/cancellation repro: **13/0**, including refused non-carrier, before-ack row/bulk/stop and after-ack cancellations. Promoted-before-ack tests: **2/0**.
- Rewind-target real-store repro: **8/0**, including pending queue prompts, multi-block inbox deliveries, steers, promptless continuations and copied fork-prefix IDs. Committed lookup tests: **7/0**.
- Counted claims/isolation: **10/0**; real-git checkpoints: **12/0**; review2: **12/0**; startup-stop filters: **2/0**. No regression was found in these earlier confirmed behaviors.
- IPC result passthrough is unchanged. The previously documented absence of a checkpoint assistant gateway tool remains; generic assistant text-only mapping tests pass **4/0**. No production checkpoint-refusal text or Electron transport was exercised.

## Validation

Mechanical runs/log collection were delegated to **Antigravity Gemini 3.8 Flash**, worker **97c83f0b-6e16-406a-b376-5c73ea372ae6**; review judgment and new repro design stayed with me. Bun **1.4.2**. Each targeted file ran in a separate process. Mechanical report: `/home/gideonsarfo/Developer/kone-wt/reviews/p2-2a8c1cde-mechanical.md`; targeted logs use that directory's `p2-2a8c1cde-*.log` prefix. I independently ran the new failing repro scenarios while developing them.

Existing gate logs on the exact pin were inspected, not rerun. All paths below are under **/home/gideonsarfo/Developer/kone-wt/gates/**:

| Log | Exit; result |
|---|---|
| 2a8c1cde-p2-safety-types.log | 0 |
| 2a8c1cde-p2-safety-lint.log | 0 |
| 2a8c1cde-p2-safety-agent-core.log | 0; 2699/0 |
| 2a8c1cde-p2-safety-protocol.log | 0; 124/0 |
| 2a8c1cde-p2-safety-git-core.log | 0; 73/0 |
| 2a8c1cde-p2-safety-desktop.log | 0; 405/0 |
| 2a8c1cde-p2-safety-web.log | 0; 1498/0 |
| 2a8c1cde-p2-safety-build.log | 0; --concurrency=1; both build tasks successful, zero cached; supplied invocation used 4 GB heap |

## Not done

No fixes, tracked edits, commits, pushes, other phase branches, UI, conversation-only rewind, fresh full gates/build, live provider CLI, or actual Electron IPC run. No general re-audit of unrelated adapter behavior. Repro providers/git are gated doubles except real-git agentCheckpoints tests; SQLite write fault is controlled, not actual host disk exhaustion. The two new findings concern unchanged direct-call sites explicitly included in this round's requested audit.

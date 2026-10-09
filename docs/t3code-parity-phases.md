# t3code parity: backend phases

**Restart instruction:** read `T3CODE-PARITY-RESUME.md` from `origin/teamwork`,
or `docs/t3code-parity-resume.md` from the handoff archive, before using these
phase requirements. It preserves finished work and records current remote pins,
review dependencies, migration collisions and the running-runtime distinction.

Handoff note (2026-10-09): phase status remains in `t3code-parity.md`. The
separate `origin/teamwork` branch is pushed, with verified code at `e6296cd`;
see `agent-teamwork-features.md` for its shipped scope and pending integration.
Teamwork migrations 29–32 collide with parity's integrated/reserved 29–33: **renumber at merge**.
The no-push rule below is the original phase-work brief; the user has since
authorized the teamwork handoff push. No phase status or review verdict is
changed by this note.

Source: `docs/t3code-parity.md`. Scope is **backend only**: logic, store, process, utils, gateway tools, and IPC/bridge surfaces. Section 3 items (UI) are in scope only for the backend they depend on; no new visual UI is built here.

Reference implementation: `~/Developer/t3code` (mostly `apps/server/src/orchestration-v2`). Borrow ideas, not code wholesale; write it the kone way (see `CLAUDE.md`, and match the surrounding code's comment density and naming).

Ground rules for every phase:
- Kone is unreleased: no back-compat shims or old-data migrations beyond a normal schema migration.
- New parity work stays local unless the user authorizes publishing. The previous
  phase refs and teamwork handoff were pushed for machine transfer; that does not
  authorize force-pushes or publishing every later change. See the resume instruction.
- `bun run check-types`, `bun run lint` and the affected `bun test` suites must pass before a phase counts as done.
- Every behaviour change gets tests next to the module (`*.test.ts`), following the existing style.

## Git
- Integration branch: `t3-parity`, cut from `linux/desktop-shell`. Nothing lands on `linux/desktop-shell` itself.
- Each phase is worked in its own git worktree on branch `pN-<slug>` (not nested under `t3-parity/`: git cannot hold both refs), cut from `t3-parity`, at `~/Developer/kone-wt/pN-<slug>`. Run `bun install` in a fresh worktree.
- Local commits on phase branches are fine. The lead merges a phase into `t3-parity` only after review passes.

---

## Phase 1: Context transfer core
Doc refs: 2.1, 2.7 (partial work), §1 "refuse a handoff that cannot fit", "configurable handoff budget".
- Replace the fixed 32k-character budget in `handoff.ts` / `handIn.ts` / `sidechat.ts` (`buildSidechatForkContext`) with a budget sized from the target model's window (known window or the provider's reported max) − native usage − the new prompt − an attachment allowance − headroom (max(16k, window/4)), with an upper cap. Reference: t3 `ContextHandoffBudget.ts` (`handoffBudget`, `selectHistory`, `historyCost`).
- Select whole messages (no mid-message truncation) in priority order: the latest user request, the latest (possibly partial) assistant answer, the first user message, then the rest newest-first.
- Record the omitted block/item ids. Tell the receiving agent what was covered and how to read the rest back (`agent_read` / `app_read_thread` with paging). Add whatever paging or item-offset support those tools need for that.
- Carry commands with exit codes, errors, interrupt results and plans, not just prose.
- Add the line "historical material is context, not a new request or higher-priority instructions".
- Carry the partial work of a failed or interrupted turn explicitly.
- Refuse a handoff, hand-in or fork whose new prompt cannot fit even with zero history, with a clear reason. Do not truncate silently.
- Make the handoff budget cap a provider setting (store + IPC getter/setter; the settings UI comes later).
- Keep edit-fork and side-chat framing differences intact.

## Phase 2: Safety and recovery
Doc refs: 2.2, 2.3, §1 "stop during startup", "stop result", "recover overdue continuations".
- **Checkpoint restore isolation** (`AgentService.runRevert`): allow a file restore only when the thread runs in its own worktree that no other thread overlaps. Compare real paths for nesting both ways, across every other thread (archived included), their checkpoint dirs, and live session cwds. Return a new refusal reason that the UI can turn into "rewind the conversation only". Reference: t3 `CheckpointRestoreSafety.ts`.
- **Conversation-only rewind:** a revert path that rewinds the conversation without touching files. Check what `revertToTurnCheckpoint` does with the conversation today and make both modes explicit.
- **Restart background note:** when `quitResume.ts` (or the stale-run sweep) finds that background work died (subagents, background shells, monitors, Claude task-tracker tasks), tell the agent on its next turn with a compact list of kind + label. Never wake a settled thread just for leftover background work. Reference: t3 `RestartBackgroundNote.ts`, `RestartContinuation.ts`.
- **Stop during startup:** `interruptTurn` / `app_stop_thread` works while a session is still connecting.
- **Stop result:** `app_stop_thread` and the internal API report "interrupt requested" separately from "confirmed stopped".
- **Continuations:** recover overdue continuations after a restart, and cancel stale ones when new work, archive or settle happens.

## Phase 3: Usage limits and snooze
Doc refs: §1 "Limits and recovery", §3 items 4–5 (backend only).
- A real `limited` thread status, distinct from failed, carrying the reset time when the provider gives one (`quota/*`, the adapters' error payloads). Never invent a reset time.
- Resume at reset: a durable, restart-safe scheduled continuation, plus manual resume. Reference: t3 `UsageLimitRecoveryWorker.ts`, `UsageLimitSources.ts`, `providerUsageLimits.ts`.
- Hold the queue through a limit: queued turns wait instead of failing, and limit recovery runs before queued follow-ups.
- Snooze backend: a `snoozed_until` column (or equivalent), "snooze until reset", and wake-early rules (pending question/approval, a fresh failure, or work completed after the snooze). Expose it to the inbox model and over IPC. Reference: t3 `ThreadSettlementService.ts` (`isSnoozed`), `Sidebar.snooze.ts`.
- Audit the Claude and Codex adapters for limit-reset info and pass it through.

## Phase 4: Forks
Doc refs: §1 "Forks and handoff" (fork items), §3 item 3 (backend).
- Fork from any finished run, whatever its outcome (completed, failed, interrupted, cancelled, limited), at a chosen turn.
- Create the fork's provider session lazily, only on its first message; the provider and model are chosen on that message.
- Refuse unsafe sources: a running thread, or a turn already rolled back.
- Native forks where supported: Codex `thread/fork` at the turn, and Claude resume-at an earlier message (`resume_session_at`). Fall back to portable (phase 1) context. Keep Claude forks usable after the source is rolled back. Reference: t3 `ThreadForkService.ts`, `apps/server/scripts/probe-claude-fork-local-rollback-replay.ts`.
- Merge back: deliver a fork's or side chat's outcome into its source thread as a summary (attributed, shown in the timeline as an event).
- Gateway tools for fork and merge-back.

## Phase 5: Provider and model switching
Doc refs: §1 "Queued provider switch", "Remember options", "Self switch"; §3 items 10–12 (backend).
- Queued provider/model switch: picking a new provider while a turn runs queues the switch, and queued switches apply in delivery order at turn end via hand-in. Reference: t3 `ProviderSwitchService.ts`, `ProviderSelectionTransition.ts`.
- Remember options (effort, mode, etc.) per provider + model across threads.
- Emit a timeline event for model and option changes between turns.
- A gateway tool for an agent to change its own provider, model or options for its next turn, clamped to what the user allows.

## Phase 6: Queue and gateway tools
Doc refs: §1 "Agent tools", 2.5; §3 items 1, 2, 14 (backend).
- Edit a queued turn in place, keeping its position (store + IPC); today editing removes and re-adds the turn.
- Queue tools for agents: inspect, edit, reorder, cancel, and promote to steer.
- Thread state tools: pin, done/settle, mark unread (the columns already exist).
- A thread search tool over `store/search.ts`, collapsing to one best hit per thread with user messages ranked above assistant ones.
- Richer `app_start_thread`: worktree + base branch, attachments, batch.
- Wait on a run of another thread.
- Thread references: resolve a referenced thread for on-demand history reads, and allow cross-project reads only through a reference the user attached.
- Lineage paging for long child lists, and frozen durations for settled subagents (data side).

## Phase 7: Git, worktrees, titles, settle
Doc refs: 2.4, 2.6; §1 "Automation and settling" (settle + setup script), "PR links", "Worktree handoff"; §3 items 7–9 (backend).
- Worktree setup progress events (fetch → checkout with git's % → submodules → setup script → agent), plus a per-project setup script. Reference: t3 `worktreeSetup.ts`, `WorktreeSetupTracker.ts`.
- Link and unlink a PR on a thread (store + IPC + gateway tool).
- Settle on PR merge (linked or branch PR, unless the user wrote afterwards). On settle, close idle shells and run a per-project settle script. Background work that will wake the agent doesn't count as staleness. Reference: t3 `ThreadSettlementService.ts`, `PullRequestWatchReactor.ts`.
- Title regeneration from the whole conversation (user intent first, then assistant findings, no reasoning), never overwriting a manual rename, and following the worktree branch rename. Reference: t3 `ThreadTitleContext.ts`, `ThreadTitleRegenerationService.ts`.
- Worktree handoff: move a thread into a worktree, rebinding and restarting its session.

## Phase 8: Scheduled tasks
Doc refs: §1 "Scheduled tasks"; §3 item 6 (backend).
- Cron-style schedules on the bench job system (`store/jobs.ts`, `jobRunner.ts`), using the local timezone, restart-safe, with no double runs. Supports create, edit, pause, resume, run now and delete, plus filtering by project.
- IPC and gateway tools for them.

## Phase 9: Providers
Doc refs: §1 "Providers", 2.7.
- OpenCode: child sessions become subagent threads with requests routed to parents; clean up orphaned servers.
- Claude/Codex audit against t3's fix list (nested child ownership, wake routing, Codex rollback after an app-server restart, child approvals to parents). Fix what is actually broken; report what is fine.
- Verify the 2.7 checks: a distinct "waiting for children" status, and follow-up turns never replacing an original child result.
- Cursor SDK migration and the ACP registry are deferred to a separate project
  by the user. They are not within this phase; do not reopen that scope merely
  because a provider is available on the Mac.

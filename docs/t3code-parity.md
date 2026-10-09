# t3code parity review

## Start here

**Newest state (2026-10-09, after the Mac power cut): read
`T3CODE-PARITY-RESUME.md` on `origin/parity-handoff` and the "Back to Linux" section below.**
Older pointer: `T3CODE-PARITY-RESUME.md` on `origin/teamwork`, or
`docs/t3code-parity-resume.md` in the earlier handoff archive. It defines the
restart order, remote pins, portable setup, migration conflicts and scope.
This resume instruction takes precedence over conflicting historical wording
below. The status table is a snapshot, not evidence of work happening now.

A simple opening request is: “Continue t3code parity. Read
T3CODE-PARITY-RESUME.md, then the docs it names; verify current refs and resume
pending work. Keep teamwork separate until independently reviewed and
migration-reconciled. Preserve review pins and existing user scope decisions.”

## Back to Linux after the Mac power cut (2026-10-09, about 06:00 UTC). START HERE

The Mac lost power mid-run. Every Mac agent (Rill, Rowan, Kofi, Noor, Dara) is gone. Their provider sessions do not move; this ledger, the pushed refs and the `parity-handoff` branch carry the state. **Read `T3CODE-PARITY-RESUME.md` on `origin/parity-handoff` first.** Everything below is the detail.

### Pushed refs (verified at push time)

| Ref | Pin | State | Next action |
|---|---|---|---|
| `origin/t3-parity` | `6a4bac3c` | P1 + P7 integrated; schema 31. Baseline gated on the Mac: all suites 0 failures | Merge target. Order: P2 → P6a → P3 → P4 |
| `origin/p2-safety` | `1f7550ec` | On 7b87bba: `07d332ee` follow-up caller test, `dc47407e` restart-note reservation tied to its carrier (finding 2), `1f7550ec` reservation released on queued-carrier cancel (finding 3). **Not gated; gates on 07d332ee are void** | Finish findings 1 and 4 (see WIP), gate the tip, re-review |
| `origin/mac-wip/p2-safety` | `b7126ba4` | Snapshot of Kofi's **uncommitted** edits at power loss, on top of 1f7550ec: AgentService.ts, checkpointRestoreSafety.ts(+test), agentSafety.review2.test.ts. Probably the restore-race fix (finding 1). Unreviewed, may be half done | Inspect; finish it as new commits on p2-safety (cherry-pick or redo). Never push it into p2-safety as one WIP commit |
| `origin/p6-queue` | `4d4de1e6` | Round 2 on 6eb52914: `8850877b` candidate paging past the store's 100 clamp (finding 1), `12f8ace9` real-store paged test, `4d4de1e6` child lineage in search scope (finding 2). Not gated | Finish finding 3 (see WIP), gate, re-review |
| `origin/mac-wip/p6-queue` | `201cc642` | Noor's uncommitted edits at power loss: store/queuedTurns.ts, store/search.ts. Probably finding 3 (cancelled queue text left in FTS). Unreviewed | Inspect, finish as commits on p6-queue, with a test |
| `origin/p4-forks` | `5c88bce7` | On 5dc8a1c: `23268101`/`8ef75eba` assistant-text ids + 10 tests; `0721d4c5`/`feee3c88`/`5c88bce7` explicit conversation-only rewind (service + IPC `agent:rewind-conversation-only` + tests). **Gated**: types/lint 0, agent-core 2763/0, protocol 124/0, git-core 73/0, web 1498/0, desktop 429/1 (only a github.test.ts prDetail 5s timeout; passes alone 3/3); build waived | First review was sent to Rowan at 5c88bce7 just before the power cut; **no verdict was received**. Re-send `reviews/p4-review-request-5c88bce7.md` |
| `origin/p3-limits` | `70592fc0` | Unchanged, unreviewed, stacked on old P2 | After P2 merges: carry it onto the new base on a new branch, then review the whole P3 range including its migration |
| `origin/p7b-handoff-wip` | `5f687467` | Unchanged, unreviewed WIP, schema 30 (behind parity) | After P2 merges |
| `origin/teamwork` | `50807c8b` | Unchanged; separate | Do not merge to resume parity |
| `origin/parity-handoff` | (docs only) | These docs plus the `kone-wt` tooling: gate.sh, RULES.md, reviews/ (reports + repro tests), gates/ledger + logs | Unpack per the resume doc |

### Review verdicts (reports in `reviews/`, on `parity-handoff`)

- **P2 at 7b87bba: CHANGES**, 4 findings (`reviews/p2-7b87bba-preliminary.md`):
  1. Restore race: isolation is checked only before the async checkpointExists/preview, so a session started in the same cwd meanwhile still gets its files restored. Repro `reviews/p2-restore-race-repro.test.ts`. Fix: re-check right before restoreCheckpoint, and hold off or refuse new work in that cwd during a restore. Keep it in checkpointRestoreSafety.ts. *WIP on mac-wip/p2-safety.*
  2. A refused non-carrier releases another send's restart-note reservation, so the note is duplicated (dispatch.ts:959–971). *Committed dc47407e.*
  3. Cancelling a queued note carrier strands the reservation, so the note is never delivered. *Committed 1f7550ec.* Repro for 2 and 3: `reviews/p2-reservation-repro.test.ts`.
  4. The rewind target's userBlockId is always null for normal prompts: store/threads.ts:499–505 queries role=user AND turn_id, but user blocks are stored with turn_id NULL (see queuedTurns.ts:384). Fix the lookup only. *Not started.*
  Everything else in the round-2 redesign was confirmed by Rowan (startup interrupt, StartCancelled, sweep, spawnFailover, job re-queue, continuationId re-check, empty note).
- **P6a at 6eb52914: CHANGES** (`reviews/p6-queue-6eb52914.md`; repros `p6-6eb52914-search-repro.test.ts`, `p6-6eb52914-queue-repro.test.ts`): (1) the 100-hit store clamp defeats candidate widening, *committed 8850877b/12f8ace9*; (2) search ignores target.parentThreadId, *committed 4d4de1e6*; (3) cancelled queue text stays in FTS with a dead block id, for per-row cancel **and** stop/bulk paths, and search should skip orphan FTS rows, *WIP on mac-wip/p6-queue*. Finding 4 (user-attached references not wired into search/read) moved to 6b. Fixes 1–6 and 8 and the promotion side of 9 are verified.
- **P4**: first review requested at 5c88bce7 (`reviews/p4-review-request-5c88bce7.md`); no verdict.
- **P5 design** (`reviews/p5-design.md`, Dara): approved by the lead with notes (`reviews/p5-design-lead.md`). Coding waits for P4 to merge.

### Lead decisions made on the Mac (keep them)

- **Conversation-only rewind moved from P2 to P4.** For P2 it is non-blocking: the shared-checkout refusal and its rewind target must be correct and survive IPC. In P4 it is blocking, and it is implemented at 5c88bce7. Rowan should check that the userBlockId=null case (cut at the last answer block) is right for a turn with no answer block.
- **User-attached references** (P6a finding 4) are part of 6b.
- **The build gate is waived on the Mac only.** Node there could not reach fonts.gstatic.com (bun/curl could), so `@nuxt/fonts` failed; the parallel build also showed a client-manifest ENOENT. On Linux, run the build normally. A build failure there counts.
- Migration plan at merge (confirm against the destination manifest each time): P2 Continuations → 32, P3 LimitAndSnooze → 33, P4 TurnRollbacks/TurnAssistantUuid → 34/35. P6 adds none.

### Tooling and lessons from the Mac

- `gate.sh` (on parity-handoff) runs gates under one machine-wide lock: `flock` on Linux, `lockf` on macOS. It needs a clean tree, pins `~/.bun/bin` first on PATH, logs `gates/<sha>-<branch>-<step>.log`, appends to `gates/ledger`, and marks a step INVALID (exit 99) if HEAD or tracked files change during it. Its shells use `zsh -f`, because an agent's interactive zsh rc once hung a gate for 11 minutes while holding the lock.
- Check the bun version: the Mac had an old 1.2.16 on PATH next to 1.4.2, which made the stdioProxy cancellation test flaky. The repo pins bun 1.3.13.
- Known flaky tests: `stdioProxy > notifications/cancelled aborts the in-flight gateway request`, `github.test.ts prDetail ... milestone` (5s timeout under load), `Antigravity native subagents > surfaces a native subagent run...` (30s timeout, seen once).
- Free OpenCode endpoints can loop: Dara's thread produced about 150 "fetch failed" turns, and each one was a notice to the lead. Withdraw such an agent at once.
- kone refuses agent_followup from a turn started by a background-task notification ("no live turn"). Send from a message-driven turn.
- Two agents can share a name (an older "Kofi" thread existed), so address agents by thread id.
- Implementer models used on the Mac (OpenCode Go was at its limit): Kofi on Antigravity Gemini 3.8 Flash, Noor on Codex GPT-6 Luna, Dara on OpenCode Muse Spark 1.3 Free (failed), Rowan reviewing on Codex GPT-6.1 Sol medium. The user offered Muse Spark 1.3 Free, Codex GPT-6 Luna and Gemini 3.8 Flash.

<details><summary>Mac session log (historical)</summary>

### Mac session (2026-10-09, coordinator and lead: Rill)

Rill holds both the old Chalk and Iris roles. Refs were verified against the resume table: all pins match. `origin/teamwork` moved d49f12c → 50807c8 (docs only).
Worktrees are in `~/Developer/kone-wt/` (integration = `t3-parity`, plus p2-safety, p3-limits, p4-forks, p6-queue, p7b-handoff-wip), each with `bun install --frozen-lockfile` done.
Gates: `~/Developer/kone-wt/gate.sh <steps>` (macOS `lockf` on `.gate.lock`; logs `gates/<sha>-<branch>-<step>.log`; summary in `gates/ledger`). Standing rules: `~/Developer/kone-wt/RULES.md`. Reviews: `~/Developer/kone-wt/reviews/<branch>-<sha>.md`.
t3code reference: `~/Developer/opensource/t3code`. The P6 defect harness archive is not on this Mac, so findings 8/9 get fresh regression tests.
Schema: parity 31; P2 29 (behind parity); P3 30; P4 33; P6 31 (no new migration); P7b 30 (behind parity). Planned renumbering, confirmed at each merge: Continuations → 32, LimitAndSnooze → 33, TurnRollbacks/TurnAssistantUuid → 34/35.

OpenCode Go hit its limit, so the implementers moved to new models (user, 2026-10-09):

| Agent | Model | Assignment (pin) | State |
|---|---|---|---|
| Kofi (thread f91f2533; a second, older "Kofi" thread exists, so address by id) | Antigravity Gemini 3.8 Flash high | P2 follow-up caller test on `7b87bba`, then fix Rowan's findings 1–4 as new commits, then gates | assigned |
| Noor (formerly "Lena", renamed because the team has a Lena) | Codex GPT-6 Luna high | P6a findings 8/9 fixed: `ebffe285` (fix plus the assistant search exemption) and `6eb52914` (web fixtures). Tests for 1–7 mapped | Rowan at `6eb52914`: CHANGES (`reviews/p6-queue-6eb52914.md`). Must fix: (1) the 100-hit store clamp defeats candidate widening; (2) search ignores target.parentThreadId; (3) cancelled queue text stays in FTS. Finding 4 (user-attached references unwired) moves to 6b. Sent to Noor for round 2 |
| Dara | OpenCode Muse Spark 1.3 Free high | P4: `23268101` and `8ef75eba` (assistant-text fixes and 10 tests; gated on 8ef75eba: all 0 except the environmental build). Conversation-only rewind added: `0721d4c5` (service entry), `feee3c88` (IPC `agent:rewind-conversation-only`), `5c88bce7` (tests); gated by Rill on `5c88bce7`: types/lint 0, agent-core 2763/0, protocol 124/0, git-core 73/0, web 1498/0. desktop 429/1, the only failure a github.test.ts prDetail 5s timeout (a file P4 does not touch; passes alone 3/3); build waived. Review request `reviews/p4-review-request-5c88bce7.md` sent to Rowan. P5 design at `reviews/p5-design.md` (not yet reviewed by the lead) | **withdrawn**: the thread looped on ~100 "fetch failed" turns (free OpenCode endpoint). P4 tip `5c88bce7` |
| Rowan | Codex GPT-6.1 Sol medium | P2 re-review (prep on `7b87bba`, verdict on Kofi's pin) → P6a → P4 → P3 | assigned |

Rowan preliminary P2 at `7b87bba`: CHANGES, 4 findings: rewind target userBlockId is always null for normal prompts (store/threads.ts:499); two restart-note reservation bugs (`reviews/p2-7b87bba-preliminary.md`, repro `reviews/p2-reservation-repro.test.ts`) and a restore race where isolation is not re-checked after the async preview (repro `reviews/p2-restore-race-repro.test.ts`). All three sent to Kofi. Whole-phase audit continuing.
Lead decision (Rill): P2's conversation-only rewind is only the shared-checkout refusal plus a rewind target pointing at the existing branch-at-block edit fork. That fork needs editedText and starts a session at once, so it is not an explicit mode. This is non-blocking for P2 (the refusal and target must be correct and survive IPC). The explicit mode moves to P4 (fork at turn, no files touched, lazy session, no send until the user writes), and it blocks P4's review.

P6a gates on `6eb52914`: types/lint/protocol/git-core/desktop/web exit 0. agent-core exit 1 is only the timing-flaky `stdioProxy.test.ts` cancelled-notification test (passes alone 3/3; passed on baseline). build exit 1 is environmental: it fails identically on baseline `6a4bac3c` (Nuxt client manifest ENOENT when desktop+web build together; fonts.gstatic fetch timeouts). Build root cause (Mac environment): Node's fetch cannot connect to fonts.gstatic.com (UND_ERR_CONNECT_TIMEOUT, even IPv4-first), while bun and curl can. A one-app-at-a-time build fails only on the @nuxt/fonts download; the parallel build adds the manifest ENOENT. Build stays waived for phases until the user fixes Node's network access (firewall?) or approves building fonts offline. Sent to Rowan.

Tooling: two bun installs. `/usr/local/bin/bun` is 1.2.16 and `~/.bun/bin/bun` is 1.4.2 (repo pins 1.3.13). Agents with different PATHs used different versions, which likely explains the stdioProxy flake. gate.sh now pins `~/.bun/bin` and logs the bun version.

P5 design (`reviews/p5-design.md`) approved by the lead with notes in `reviews/p5-design-lead.md`. P5 coding waits for P4 to merge.

Gate incident 05:20–05:32: Kofi's gate on `07d332ee` hung in a shell that never started the protocol test, holding the lock. Killed. gate.sh now uses `zsh -f` and marks a step INVALID (exit 99) if HEAD or tracked files change during it. Kofi's `07d332ee` gate results are void (the tree was edited mid-run).

Baseline gate on `6a4bac3c` (Mac): types 0, lint 0, agent-core 2732/0, protocol 124/0, git-core 73/0, desktop 430/0, web 1498/0, all exit 0. Logs in `~/Developer/kone-wt/gates/6a4bac3c-t3-parity-*.log`.


</details>

## Teamwork handoff addendum (2026-10-09)

`origin/teamwork` is now available separately, with fully gated code at
`e6296cd`. See `docs/agent-teamwork-features.md` “Implementation and Mac
handoff” for the complete feature/review/validation record. Chalk's provider
is currently at its limit; use those docs to continue without waiting for it.
The branch is not merged into `t3-parity` or `linux/desktop-shell`. Teamwork's
migrations 29–32 collide with parity's integrated/reserved 29–33: **renumber at merge**, using the
integration branch's next available IDs and updating schema/tests together.

The original phase handoff below describes the earlier fleet snapshot. Its
“contractor ends after the first turn”, “only Chalk can reach it”, and “a note
never wakes” rules are superseded on `teamwork`, which adds explicit contract
closure, peer grants and authorized wake-capable notes. They still describe
branches without those changes. No parity phase was re-reviewed or merged as
part of this handoff; keep its pending reviews and pins intact.

The teamwork code push is user-authorized. Earlier local-only/no-push rules
below are historical instructions for phase work, not a ban on this handoff.
Planning docs ignored by git must be transferred with the supplied archive
unless explicitly committed. The two existing roles/delivery design docs are
already tracked despite `docs/` being ignored.

## Status and handover (2026-10-09)

The phase plan is in `docs/t3code-parity-phases.md` (nine phases, backend only). Both
docs are gitignored (`docs/` is in `.gitignore`), so copy them by hand to another machine.
This section was rebuilt from the fleet's threads: what each agent was asked, what it
did, and the messages it never got to read.

### The brief (user, 2026-10-08 14:19)
Work on the backend part of this doc: logic, process, utils, plus any UI item that
depends on a backend change. Split it into phases of closely connected changes.
Contract and run an agent fleet:
- Lead ("brain"): Claude Opus 5.5, medium effort.
- Reviewer: Codex GPT-6.1 Sol, medium effort.
- Implementers: OpenCode Go DeepSeek V4.1 Flash, as kone agents (not subagents).
- More than one contract per role is fine.
- Small, fast workers that agents can start for searches and other jobs: Codex Luna,
  Claude Haiku, Gemini 3.8 Flash.

### Orchestration setup (approved by the user 14:22)
```
Chalk (main thread, Opus 5.5): holds every contract and relays to the user.
│   Contracts every agent directly, so all of them sit at depth 1 and can start workers.
├── Iris (lead, Claude Opus 5.5 medium): owns the plan, assigns phases, checks plans,
│     merges approved phases into t3-parity
├── Rowan (reviewer, Codex GPT-6.1 Sol medium): reviews each phase branch for bugs,
│     tests and type/lint gates; sends findings to the implementer and Iris
└── Implementers (OpenCode Go DeepSeek V4.1 Flash): Iris directs them by message;
    they report to Iris, then Rowan reviews
      Dara → Phase 1 (context), then Phase 4 (forks), then Phase 5
      Kofi → Phase 2 (safety), then Phase 3 (limits)
      Lena → Phase 7 (git, titles, settle), then Phase 6 (queue and gateway tools)
    Each implementer starts its own fast workers: Codex GPT-6 Luna, Claude Haiku 4.5,
    Gemini 3.8 Flash
```
Waves (run in parallel, chosen so they touch different files):
1. P1, P2, P7
2. P3, P4 (after P1), P6
3. P5 (after P1 and P4), P8
4. P9

Iris may reorder the waves.

The path each phase follows:
1. Worktree `~/Developer/kone-wt/pN-<slug>` on branch `pN-<slug>`, cut from `t3-parity`.
2. Recon with workers, and a plan sent to Iris.
3. Build with tests.
4. Gates: check-types, lint, tests.
5. Rowan reviews; fixes go back and forth until he approves.
6. Iris merges into `t3-parity`.

Local commits only. `linux/desktop-shell` is never touched.

### Rules the fleet settled on (keep these)
- **Branch names:** phase branches are plain `pN-<slug>`. Git can't hold `t3-parity/pN-*`
  next to a `t3-parity` branch.
- **Gates:** run the heavy ones one at a time, as `flock ~/Developer/kone-wt/.gate.lock <cmd>`.
  They are `bun run check-types`, `bun run lint`, and `bun test` in `packages/agent-core` and
  `apps/desktop` (plus `packages/git-core` and `apps/web` where touched). Paste the output
  for the **exact commit**. Iris's integration worktree is `~/Developer/kone-wt/integration`.
  The baseline has one flaky test: the OpenCode warm-spare test, which passes on its own.
- **Reviews are pinned to a commit.** A branch under review only grows: findings land as new
  commits, with no amends, rebases or force-moves. Lena breaking this on 6a cost a round.
- **Migrations:** each phase adds its migration as one self-contained function. Iris
  renumbers at merge, in merge order. Taken so far:
  - Integrated parity 29: P1 omitted history. P2 separately uses 29 for
    Continuations; reconcile that collision at merge, preserving both changes.
  - Integrated parity 30–31: P7 title origin and thread PR
  - Reserved on unmerged P4: 32–33, turn rollbacks and assistant uuid
  - P3 adds the limit and snooze columns: 30 on its own branch, renumbered at merge
  - 6b starts at the next free id.
- **Gateway tool output:** for the production assistant target, `registry.ts:178` strips
  `structuredContent` (see `gateway/index.ts:331`). Everything an agent needs to act on must
  be in the text: ids, snippets, refusal reasons. Refusals are `isError` text, never success
  prose. Test every tool through the `target:'assistant'` mapping. This applies to every
  new tool in P3, P4, P6 and P7.
- **Shared code:** `AgentService.ts` (about 3,400 lines) is shared by every phase. Keep edits
  there small and put new logic in new modules with tests.
- **Kone is unreleased:** no legacy-data branches or back-compat shims.
- **Scope decisions already made by the user:**
  - Cursor SDK and the ACP registry are deferred to a separate project.
  - New visual UI is out of scope. Section 3 looks are the user's call. Example: the
    composer's queued-message edit still cancels and resends; 6a is backend only.
- **kone mechanics:**
  - A contracted agent counts as "completed" once its turn ends. After that, messages to it
    are refused or sit unread, and only the contractor (Chalk) can reopen it with
    `agent_followup`.
  - Agents send "RELAY to <name>: …" questions to Chalk when they can't reach someone.
  - A note never wakes an idle agent; question, report and answer do.
  - OpenCode sessions sometimes wedge and get reset. Check the worktree before restarting.

### Where each phase stands
Every branch below was pushed to origin on 2026-10-09. Nothing is running: the fleet was
stopped on 2026-10-09 at about 01:09.

| Phase | Branch @ commit | State |
|---|---|---|
| 1 Context transfer | merged (`ce24822`) | Approved by Rowan after 4 rounds; in `t3-parity` |
| 7 Git, titles, settle, setup progress, scripts | merged (`6a4bac3`) | Approved after 4 rounds; in `t3-parity`. Covers title regeneration (with a manual-rename guard and branch rename), PR link/unlink, settle on PR merge, worktree setup progress, and per-project setup/settle scripts |
| 7 worktree handoff | `p7b-handoff-wip` @ `5f68746` | Unreviewed WIP (`moveThreadToWorktree`, IPC, `app_move_thread_to_worktree`). Held until P2 merges, because it touches the session lifecycle |
| 2 Safety and recovery | `p2-safety` @ `7b87bba` | Round-2 fixes for Rowan's 5 findings, with the startup-interrupt redesign. Gates green. **Rowan never started this re-review**: Iris's request is unread in his inbox |
| 3 Limits and snooze | `p3-limits` @ `70592fc` | Six P3 commits stacked on `7b87bba`; Kofi says gates were green. Not reviewed. Review the complete P3 range `7b87bba..70592fc`; `4f2c688..70592fc` would omit its first store migration |
| 4 Forks | `p4-forks` @ `5dc8a1c` | Done and frozen; gates green (agent-core 2751, desktop 430). **Rowan never started this review**: the pin is unread in his inbox |
| 6a Queue and gateway tools | `p6-queue` @ `2deadd1` | `14f3ed2` fixes 6a findings 1-7; **8 and 9 are not fixed**. Full gates on the fix commit never finished. `2deadd1` is a small test fix I committed (that test file passes, 28/0) |
| 6b | partly on `p6-queue` (`502486c`) | Only the read scope on `app_read_thread` exists. Its assistant exemption is correct (user decision 2026-10-09) |
| 5 Provider switching | not started | Next for Dara. She never read the assignment |
| 8 Scheduled tasks | not started | |
| 9 Providers | not started | Scope: OpenCode child sessions, orphaned-server cleanup, the Claude/Codex audit, and the 2.7 checks |

`p6-queue-rebased` and `p6-queue-merged` are local-only leftovers from Lena's rebase.
`p1-context` and `p7-git` are merged and can be deleted.

### Pending work, per person (what each was told and hadn't done)
**Rowan (reviewer).** Never read these:
1. Re-review `p2-safety` pinned at `7b87bba`. Check the redesign rather than assume it:
   - An interrupt during startup is recorded and applied to the first accepted turn
     (`noteAccepted` → `interruptTurn`).
   - `StartCancelled` is only stop-during-startup. The sweep consumes cancelled
     continuations with no backoff.
   - `spawnFailover` marks the child stopped with SpawnError `cancelled` and keeps the brief.
   - `jobRunner` re-queues.
   - `dispatchComposed` re-checks via `continuationId` at the handoff.
   - The restart note is reserved for one delivery, and the empty-list guard is removed.

   Fold in Kofi's test commit if it exists (it doesn't yet).
2. 6a fix re-review, once Lena's fix commits are complete. Re-run `/tmp/kone-p6-review.test.ts`
   (10 defect assertions; snapshot in `/tmp/kone-p6-review-snapshot`).
3. Phase 4 first review at `5dc8a1c`:
   - Check that forks work from failed, interrupted, cancelled and limited runs (the open (?)).
   - Lazy session, and refusing unsafe sources.
   - A Claude fork stays usable after its source is rolled back.
   - Native forks are unit-tested only.
4. Then the Phase 3 review.

**Kofi (P2, P3).**
- Add the follow-up-caller test as its own test-only commit on top of `7b87bba`. That hash
  becomes Rowan's pin. `7b87bba` is frozen.
- Phase 3:
  - Make sure the wake-early rules live in `isSnoozed` and are tested: pending
    question/approval, a fresh failure, work completed after the snooze.
  - Never invent a reset time.
  - Apply the gateway-text rule to `app_snooze_thread`, `app_resume_thread` and
    `app_stop_thread`'s new fields.
  - Gate, send Iris the range, then freeze.
- If the P2 review forces new commits, rebase `p3-limits` onto the new P2 tip **before** its
  review, never during it.

**Lena (6a, 6b).**
- Finish the 6a fixes as new commits on `p6-queue`:
  - **Finding 8:** `searchCollapse.ts:22` ranks imported assistant blocks as user hits. Rank
    by actual authorship, and test imported assistant vs user matches.
  - **Finding 9:** `queuedTurns.ts:176`. An edit doesn't refresh `conversation_fts`; call
    `indexBlockRow` inside the edit transaction, and test search after promotion.
  - Confirm 1-7 against Rowan's harness.
  - Run the full gates on the exact commit, then send Iris the hashes.
- **Keep the assistant exemption** in `canReadThread` / `app_read_thread`. This overrides
  Iris's earlier instruction to remove it (user decision 2026-10-09). The global assistant
  reads any thread. Every other caller reads its own thread, its own project, fork/source
  lineage and spawn parent/child; cross-project only through user-attached references.
  Make sure the search tool follows the same rule, and that a test covers the exemption.
- Then the rest of 6b:
  - User-owned thread references: stored per caller thread, written only by the
    renderer/IPC "attach" action, never by a gateway tool, with a forgery test. Send Iris
    the shape first.
  - Richer `app_start_thread`: worktree and base branch wired to P7's setup tracker,
    attachments, batch.
  - `app_wait_for_run`.
  - Lineage paging and frozen subagent durations.

**Dara (P4, then P5).** Never read these:
- Apply the gateway-text rule to `app_fork_thread` and `app_merge_back` (new thread id and
  refusals in the text, `isError` refusals, tested via `target:'assistant'`). Probably needs
  a commit on top of `5dc8a1c`.
- Phase 5 prep, without touching a branch: read t3code's `ProviderSwitchService.ts` and
  `ProviderSelectionTransition.ts`, and kone's queued switch, hand-in at turn end and
  `model_selection_json`. Then send Iris a design for how a queued switch rides delivery
  order at turn end, before any coding.

**Iris (lead).**
- Merge order: P2, then 6a, then P3, then P4 (as each is approved). Renumber migrations
  at merge.
- Then P7's worktree handoff, 6b, P5, P8, P9.
- The final report goes to Chalk.

### Decisions by the user
- **The global assistant reads any thread freely** (2026-10-09). It is the one deliberate
  exemption from the read scope. Planned use: an agent that can't read a thread it needs
  asks the global assistant to read it and pass back the relevant information. That
  "ask the assistant" path is future work, not part of 6b.

### Known risks
- Native forks are unit-tested only; live Codex `thread/fork` and Claude `forkSession` are
  untested.
- Merging P2 first moves P3's base. P3 must be rebased before its review.

### Lessons from the first run (every agent on this work adopts these)
On top of the rules above:

**Briefs and instructions**
- Every instruction names the commit it applies to ("findings at `7b87bba`"). Before
  acting, check the branch tip. If the tip has moved past it, tell the sender instead of
  redoing work that may already be done. Dara fixed findings already fixed at a newer commit.
- Put the standing rules in the opening brief, not in mid-run notes. That covers the gate
  lock, no rewrites under review, gateway text output, migration handling and branch names.
  Notes sent to idle agents were never read.
- When a review finds a rule that applies beyond its own branch (like the
  `structuredContent` rule), the lead sends it to **every** implementer as a wake-up
  message (question or report), and confirms each one acknowledged it.

**Messages and reachability**
These rules describe the old running app. Teamwork changes apply only after its
reviewed integration and rebuilding/restarting the app; editing that branch alone
does not enable its tools in the gateway.
- Anything an agent must act on goes as `question` or `report`, never `note`; a note does
  not wake an idle agent.
- Don't end a turn just to wait for the lead. Keep working on what doesn't depend on the
  answer, and only stop when everything left needs it.
- Never claim something is in progress until its owner has acknowledged it. Iris reported
  Rowan "starting" a review he never received.
- The lead needs access to each agent's thread. If that isn't possible, the reviewer sends
  full reports straight to the lead and keeps a copy under `~/Developer/kone-wt/reviews/`
  (one file per pin), so a crash can't lose the only copy.

**Status**
- The lead keeps "Where each phase stands" and "Pending work" in this doc up to date after
  every merge, review verdict, or new assignment. If it isn't written here, it isn't the
  state.
- Each report states the branch, the exact commit, the gate results on that commit, and
  what is **not** done.

**Implementation**
- Implementers build their phase themselves, in small commits. Workers get lookups and
  single scoped edits, never a whole phase: the one-worker phase froze and was redone by hand.
- Before asking for review, self-check:
  - failure, cancel and interrupt paths
  - concurrent writers and transactions
  - tool output as the agent actually sees it (`target:'assistant'`)
  - search index and event payloads after edits
  - migration numbering

  Phases 1 and 7 each took four review rounds, mostly on these.
- Stacking a branch on another unmerged branch (like P3 on P2) needs the lead's approval.
  It rebases only before its review starts.

**Resources**
- At most three implementers active at once, and every heavy gate goes through the lock.
  The Linux machine has 4 cores and 7 GB, and running in parallel killed all three
  implementers once.
- Reviewers may reuse the implementer's gate output for the exact pinned commit. They re-run
  only targeted tests and repros. Re-running the full suite in parallel just queues behind
  the lock.
- Reserve migration ids per phase at assignment time, instead of everyone taking the next
  free id and renumbering at merge.

**After a crash or reset**
- Check the worktree first: `git status`, the branch tip, and the last commits. Then rebuild
  the state from this doc, then resume. Don't restart a phase from the brief.

### Resuming on another machine

Use `T3CODE-PARITY-RESUME.md` (tracked on `origin/teamwork`) or
`docs/t3code-parity-resume.md` from the archive. Its setup uses remote refs on a
fresh clone and preserves existing worktrees. The earlier `git switch t3-parity`
and `git worktree add ... $b` example assumed local branches already existed.

The refreshed archive contains the historical P6 harness at
`handoff/parity-review/kone-p6-review.test.ts`. It expects defects to occur and
imports a hard-coded Linux snapshot. Port its repros with corrected expectations
to the current branch; do not mistake a passing defect harness for fixed code.

The Mac's fleet starts from the docs, not Linux provider sessions. Start with P2
re-review preparation and P6 findings 8/9; serialize heavy gates, persist reports
by pin, and record assignments/reviews/merges in this ledger. Neither Chalk's
availability nor immediate teamwork integration is required.

---

Compared t3code's feature list (and its code in `~/Developer/t3code`, mostly
`apps/server/src/orchestration-v2`) against kone as of 2026-10-08.

Three sections:

1. **What we don't have:** behaviour and plumbing with little or no new UI.
2. **What we have but can improve:** kone already does it; t3code does something worth taking.
3. **What we don't have and is mainly a UI change:** needs a look at how it should appear before building.

Items marked **(?)** were not fully verified from the code and need a closer check.

---

## 1. What we don't have

### Forks and handoff
- **Native forks where the provider supports them.** Codex `thread/fork` at the selected turn, and Claude resume-at an earlier message. Today every fork and handoff replays text through `fork-import`. Kone already stores `resume_session_at`.
- **Fork from any finished run,** including failed, interrupted, cancelled and limited ones. Today: edit-fork, side chat, and handoff with a `branch` cut (`handoff.ts`). Check that all of these accept non-completed runs **(?)**.
- **Create the fork session only when needed:** no provider session until the fork's first message is sent. The provider is chosen on that first message.
- **Refuse unsafe fork sources:** forking from a running thread, or from a turn that was already rolled back.
- **Merge back:** carry a fork's or side chat's outcome back into its source thread as a summary.
- **Queued provider switch:** switch provider or model without stopping the running turn. The switch applies when that turn ends, and several queued switches apply in order.
- **Refuse a handoff that cannot fit** the target's context, instead of truncating silently.
- **Configurable handoff budget.** t3: `T3CODE_CONTEXT_HANDOFF_TOKEN_CAP`, default 16k tokens, max 64k.
- **Remember options per provider and model:** reasoning effort, mode and so on remembered per provider and model across threads, not only per thread (`model_selection_json`).

### Agent tools (gateway)
- **Thread search:** `store/search.ts` already does FTS5 search, but no agent tool exposes it.
- **Queue tools:** inspect, edit, reorder, cancel, and promote to steer.
- **Thread state tools:** pin, settle/done and mark unread. The database columns `pinned_at`, `done_at` and `last_visited_at` already exist.
- **Self switch:** an agent changes its own provider, model or options for its next turn.
- **Richer launch:** `app_start_thread` can launch in a new worktree with a chosen base branch, include attachments, and start several threads in one call.
- **Wait on a run:** wait for a given run of another thread, not just a child's.
- **PR links:** link and unlink a pull request on a thread.
- **Fork and merge-back tools.**
- **Worktree handoff:** move a running thread into a worktree, rebinding the session.
- **Cross-project reads,** allowed only through a reference the user attached.
- **Stop result:** `app_stop_thread` reports "interrupt requested" separately from "confirmed stopped" **(?)**.

### Limits and recovery
- **Limited status:** a usage limit is a thread state, not only an error class. Today it is only used for spawn failover in `adapters/errors.ts`.
- **Resume at reset:** automatic, using the reset times kone already reads in `quota/*`. Never make up a reset time when the provider doesn't give one. Reference: t3 `UsageLimitRecoveryWorker.ts`.
- **Hold the queue through a limit:** queued messages wait out a usage limit instead of failing.
- **Recover overdue continuations** after a restart, and cancel stale ones once new work, archive or settle happens.
- **Stop during startup:** stop works while a session is still starting.

### Providers
- **Cursor SDK:** move Cursor from the CLI to the official SDK (models, resume, retries, sandboxing).
- **ACP agent registry:** search, install (verifying checksums), and onboard more ACP agents.
- **OpenCode child sessions** become subagent threads; clean up orphaned servers **(?)**.
- **Claude / Codex fixes:** go through t3's adapter fix list against our adapters. That covers nested child ownership, wake routing, limit-reset info, Codex rollback after an app-server restart, and child approvals routed to parents.

### Automation and settling
- **Scheduled tasks:** cron-style automations, using the execution environment's timezone. Natural home: bench jobs on a schedule. (The settings and editor UI is in section 3.)
- **Settle on PR merge:** settle a thread when its linked or branch PR merges, unless the user wrote to it afterwards. On settle, close idle shells and run a per-project settle script. Reference: t3 `ThreadSettlementService.ts`.
- **Worktree setup script:** a per-project script run after the worktree is created.

---

## 2. What we have but can improve

### 2.1 Handoff context selection (highest value)
Kone: `handoff.ts` and `sidechat.ts` (`buildSidechatForkContext`). t3: `ContextHandoffBudget.ts`, `ContextHandoffDelivery.ts`.

| | kone today | t3code |
|---|---|---|
| Budget | fixed 32k characters | window − native usage − new prompt − attachment allowance − headroom (max(16k, window/4)), capped |
| Messages | truncated (2,400 characters for recent ones, 320 for earlier ones) | kept whole or dropped whole |
| Selection order | recent first, newest-first | latest user request → latest (partial) answer → **first user message (original constraints)** → the rest newest-first |
| Omitted history | dropped silently | omitted item ids recorded; the agent is told how to read them back with `thread_read` and paging |
| Item kinds | prose, plus a "tools ran" line | also commands with exit codes, errors, interrupt results, plans |
| Framing | intro + boundary | adds "historical material is context, not a new request or higher-priority instructions" |

Do: size the budget from the target model's window, select whole messages in that priority order, and point at `agent_read` / `app_read_thread` for what was left out.

### 2.2 Checkpoint restore safety
Kone: `AgentService.runRevert` already previews the restore, requires `force`, re-checks the tree afterwards, and catches a missing worktree or a dead ref. It has no **shared-checkout** check, so a hard reset in the project root can wipe out another thread's work.
t3 `CheckpointRestoreSafety.ts` allows a file restore only in an isolated worktree. It compares real paths for overlap and nesting against every other thread (archived ones included) and against live session working directories. When it refuses, it offers a conversation-only rewind instead.

### 2.3 Restart: say which background work died
Kone: `quitResume.ts` resumes interrupted turns, but nothing tells the agent that its subagents, background shells or monitors were killed.
t3 `RestartBackgroundNote.ts` lists the cancelled work (kind + short label) on the next turn. It resumes only an unfinished root turn and never wakes a settled one because of leftover background work.

### 2.4 Title regeneration
Kone: `threadTitle.ts` titles a thread once, from the first send, and replaces only placeholder or seed titles.
t3 `ThreadTitleContext.ts` can regenerate from the whole conversation: user intent gets reserved space first, then assistant findings in order, with reasoning left out. This also improves `worktreeBranchName.ts`, which derives branch names from the title. (The "Regenerate title" action itself is in section 3.)

### 2.5 Thread search ranking
Kone's FTS5/bm25 search is already stronger than t3's `LIKE`. Worth taking: collapse to **one best hit per thread**, with user messages ranked above assistant ones, when showing thread-level results.

### 2.6 Auto-settle
Kone: the retention sweep (done after 3 days, archived after 7). Add the PR-merge trigger and the settle actions from section 1. Background work that will wake the agent does not count as staleness; a dev server left running does.

### 2.7 Things to check rather than change **(?)**
- **"Waiting for children":** shown as a status distinct from "working".
- **Original child result:** a follow-up turn must not replace the result the parent already received.
- **Partial work in a handoff:** a failed or interrupted turn's partial work is carried explicitly.

---

## 3. What we don't have and is mainly a UI change (look and feel needs your call)

Each item needs a decision on how it looks before it is built.

1. **Queued message editing in place.** Today `onQueueEdit` (`AgentComposer.vue:1078`) removes the row and **overwrites the user's current draft**, and the message loses its queue position. t3 (`queued-run-edit.ts`) edits in place under a separate draft key and gives back the untouched draft on cancel. To decide: edit inside the queue strip, or in the composer with an "editing queued message" state? What do Save and Cancel look like?
2. **Thread reference chips.** Add a thread to the composer by searching titles (e.g. `@thread`) or by dragging it from the inbox or studio. The chip opens the source thread, and the agent fetches its history on demand. To decide: chip look next to `MentionChip`, and the picker.
3. **Fork actions.** "Fork from here" on any finished run in the timeline, a provider picker on the fork's first message, and "Merge back into source". To decide: where they sit (turn hover menu, `useIntentMenu`) and how a merge-back shows up in the source timeline.
4. **Limited status and recovery controls.** A distinct "limited" state in the inbox and studio, showing the reset time, with "Resume now", "Resume at reset" and "Snooze until reset" controls. To decide: the badge, its colour, and where the controls live.
5. **Snooze.** Snooze a thread until a time or until the limit resets; it wakes early on an error, a question or completed work. To decide: the snooze menu and how snoozed threads look in the inbox.
6. **Scheduled tasks screen.** Create, edit, pause, resume, run now and delete automations, with filtering by project. To decide: a bench tab or its own surface, and the schedule editor.
7. **Worktree setup progress.** Staged progress (fetch → checkout with git's % → submodules → setup script → agent), with logs and errors shown. To decide: where it shows while the first turn waits.
8. **Linked PR on the thread.** Show the linked PR and its checks in the thread (ThreadInfoPanel or the column header), with link and unlink. Git space already has the PR views.
9. **"Regenerate title" action** in the thread menu.
10. **Queued provider switch in the composer:** picking a provider while a turn runs queues the switch and shows it as pending.
11. **Timeline marks for model and option changes** between turns (handoffs already have `HandoffMark`).
12. **Handoff budget setting** in provider or agent settings.
13. **Remappable shortcuts** for alternate send, queued steer and queue edit.
14. **Lineage polish:** page long lists of children and freeze the shown duration once a subagent settles.


# Resume t3code parity on the Mac

Use this as the starting instruction for a new agent. Snapshot verified against
origin on 2026-10-09. This file authorizes no new code task beyond the user's
request to continue parity; the phase plan and prior user scope decisions govern.

## Read first and establish state

1. Read `docs/t3code-parity.md` (status, pending work and decisions), then
   `docs/t3code-parity-phases.md` (phase requirements), and `TEAMWORK-HANDOFF.md`
   (separate completed branch). Read repository agent instructions as applicable.
   These planning docs are in the handoff archive; Git alone does not carry the
   ignored parity docs. If missing, unpack the archive before assigning work.
2. Run `git status`, `git worktree list`, `git fetch origin` and inspect local
   and remote branch tips. Compare them with the table below. If a branch moved,
   inspect the new commits and refresh the ledger before acting on old findings.
   Preserve existing worktrees and uncommitted edits. Do not restart completed
   phases from their requirements or treat an implementation claim as approval.
3. Linux agent conversations and provider sessions do not move with Git. Chalk
   is provider-limited; the next agent takes the coordination role and uses the
   written ledger rather than waiting for Chalk/Iris/Rowan to answer. Names below
   describe roles from the earlier fleet, not people who must still be running.

## Verified refs and pending work

| Remote ref | Pin | Next action from the prior handoff |
|---|---|---|
| `origin/t3-parity` | `6a4bac3` | Integration contains approved P1/P7; do not rebuild those |
| `origin/p2-safety` | `7b87bba` | Add the requested caller regression test as a new commit if absent, gate the new pin, then independent re-review of the startup/continuation/restore fixes |
| `origin/p6-queue` | `2deadd1` | Reproduce/fix findings 8 and 9, confirm fixes 1–7, run full gates on the new tip and independent re-review |
| `origin/p3-limits` | `70592fc` | Unreviewed; depends on P2. Review the complete original range `7b87bba..70592fc`, including the first store migration at `4f2c688` |
| `origin/p4-forks` | `5dc8a1c` | Audit assistant-target text/refusal output for fork/merge-back, append fixes if needed, independent review; live native forks remain unprobed |
| `origin/p7b-handoff-wip` | `5f68746` | Unreviewed worktree-move WIP; hold until P2 integration |
| `origin/teamwork` | `d49f12c` | Completed code gated at `e6296cd`, plus docs. Separate from parity; fixes still need independent re-review before integration |

These refs were verified, not the old gate/review claims on every phase. Read
"Pending work, per person" for each assignment's detailed acceptance criteria.

Start with P2 re-review preparation and P6 findings 8/9. They can proceed
independently, but heavy gates must serialize. Do not assume an unread old
request means its review was performed. The P6 defects are:

- Imported assistant blocks must not rank as actual user-authored search hits.
- Editing a queued message must refresh the full-text index in the same
  transaction; verify search after promotion, and no stale old-text match.

The archive includes `handoff/parity-review/kone-p6-review.test.ts` as historical
reproduction evidence. Its assertions expect defective behavior and import a
hard-coded Linux snapshot; **passing it is not evidence that fixes work**.
Port each relevant reproduction to the current branch with correct expected
behavior and checked-in regression tests. Do not run it unchanged against a
snapshot and call that review of the new tip. It is not a portable test suite.

## Integration and migration rules

Merge only independently approved, gated work into `t3-parity`, preserving
review pins. Preferred order remains P2 → P6a → P3 → P4, as each is approved;
then P7b, P6b, P5, P8 and P9. P5 depends on P1/P4. Prepare designs or independent
work while awaiting reviews. Leave `linux/desktop-shell` unchanged.

P3 is stacked on old P2. Before its first review, bring approved P2/integration
changes into an explicit continuation/integration branch and record the new
base and pin. Preserve the original remote ref; never rewrite a branch during
review. Review all P3 behavior, including its store migration, after rebasing or
merging dependencies; the old `4f2c688..70592fc` range omitted that first commit.

Migration numbers differ between branches. Verified manifests:

| Branch/pin | Migration meanings |
|---|---|
| parity `6a4bac3` | 29 HandInOmittedHistory, 30 TitleOrigin, 31 ThreadPullRequest |
| P2 `7b87bba` | 29 Continuations, which collides with parity's 29 |
| P3 `70592fc` | P2's 29 plus 30 LimitAndSnooze, also colliding |
| P4 `5dc8a1c` | parity 29–31 plus 32 TurnRollbacks and 33 TurnAssistantUuid |
| teamwork `e6296cd` | 29 ContractClosed, 30 InboxReceipts, 31 AgentGrants, 32 CrewBoards |

Thus 29–33 are occupied or reserved across parity work, not all already merged.
At every merge inspect the destination manifest, preserve existing migration
meanings, assign incoming changes the actual next free IDs and update
`SCHEMA_VERSION`, registration, function names and tests together. Do not
reuse a conflicting rung, drop a migration or assume 34 will still be free.
Do not run mismatched branch schemas over the same existing database.
Teamwork migrations are explicitly **renumber at merge**.

Do not merge teamwork just to resume parity. It is optional integration work
with review, migration reconciliation and full combined gates. Until it is
integrated **and the running app is rebuilt/restarted with it**, the fleet
cannot assume its grants, open contracts, wake-capable notes or board tools are
available. The Git branch an agent edits does not change the running gateway.
On the old runtime use wake-capable questions/reports for assignments and
persist review reports by pin; do not depend on idle notes or Chalk's relays.

## Scope, review and gates

- Backend only: logic, store, process, tests, tools and necessary IPC/bridge
  surfaces. New visual UI remains out of scope. Cursor SDK migration and ACP
  registry are deferred by the user; do not reopen them as a lead's choice.
- Preserve the global assistant's deliberate unrestricted read exemption.
  Other callers retain scope limits; cross-project references are user-owned
  and written through authenticated renderer/IPC, never forged by a tool.
- Test tools through the production `target: "assistant"` mapping: ids,
  snippets, refusal reasons and actionable data must survive in text;
  refusals are `isError`. Do not rely on `structuredContent` surviving.
- Findings land as new commits. No amend, rebase or force-push under review.
  Old pins stay reachable. Record approval and gates against the exact new tip.
- Use one shared gate lock across **all** worktrees. On Linux it was
  `~/Developer/kone-wt/.gate.lock`; on the Mac agree on one shared path, using
  `flock` if installed or another real interprocess lock. Do not treat a missing
  `flock` as permission to run concurrent suites. Run gates in the foreground
  and wait in the same turn; no background jobs/Monitor for gate completion.
- Run `bun run check-types`, `bun run lint`, and the agent-core, protocol,
  git-core, desktop and web suites where affected; build before completing.
  Capture exit codes and full logs named by commit. An output/log file alone
  does not show that a gate finished. Reuse only complete evidence for the same
  exact commit; after integration gate the combined tip.
- New Mac worktrees need `bun install --frozen-lockfile`; check native module
  setup and live-provider behavior separately from unit tests. Historical
  warm-spare/remote-avatar failures are not blanket exemptions for new failures.
- Default new parity commits to local branches. The earlier pushes and this
  teamwork handoff are authorized; they do not imply publishing every future
  parity change. Do not force-push or publish new phase work without user scope.

## Worktrees on a fresh clone

Run from the repository root. This example applies only when the corresponding
local branches and paths do not already exist; inspect first and reuse existing
worktrees instead of overwriting them:

```sh
git fetch origin
mkdir -p ../kone-wt
git worktree add --track -b t3-parity ../kone-wt/integration origin/t3-parity
for b in p2-safety p3-limits p4-forks p6-queue p7b-handoff-wip; do
  git worktree add --track -b "$b" "../kone-wt/$b" "origin/$b"
done
```

The integration branch is `t3-parity`, even when its worktree directory is named
`integration`. Do not accidentally commit parity changes on the teamwork doc
branch you used to read this instruction. Read `git branch --show-current`
before editing. Do not launch every provider/test suite at once.

## Maintain the handoff as you work

After every assignment, finding, gate, approval and merge, update the parity
status table and pending-work lists: branch, exact pin, dependency/base, owner,
verdict, complete gate evidence, next action and what remains undone. Preserve
reports outside an agent transcript, one file per pin. Copy/update the ignored
planning docs for the next machine; do not assume a Git push includes them.

First report from the new coordinating agent: verified refs/worktrees, any
changes from this snapshot, the current migration manifest and concrete next
assignments. Then continue work within the user's authorized parity scope.

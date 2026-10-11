# Phase 4 re-review — CHANGES

Branch: `p4-forks`. Reviewed commit: `db3aa9a1079634d1dc2f54a91ab6cbbd7792cb46` (`db3aa9a1`). Range: `5c88bce7..db3aa9a1`, against the six findings in the first review. Worktree: `/home/gideonsarfo/Developer/kone-wt/p4-forks`. Checked SHA and branch before starting; tracked tree was clean. No implementation changes made.

**Verdict: CHANGES. F1–F6 are fixed; one new P2 finding, F7, remains in the portable snapshot added for F2.**

## F7 — P2 / medium: native fork snapshot discards sender and prompt stamps

Location: `packages/agent-core/src/threadFork.ts:171–178` (new `importedBlocks` construction in `writeNativeForkThread`), especially line 177. Source locations are relative to the pinned worktree.

Concrete scenario: a source contains a system-attributed merge-back notice or an agent-authored prompt before the chosen finished turn. Create a native-capable fork. The new snapshot copies only id, role, text, time and attachments; it omits `sender` and the prompt's `model`/`effort`. The fork's imported notice now has no sender, which means the user authored it (`types.ts` MessageSender contract; `@kone/protocol` `senderLabel` returns “User” for an absent sender). Native and portable fork paths therefore disagree about who spoke. This also affects the history retained when a native fork changes provider on its first message. Prompt stamps disappear as well.

Repro: `/home/gideonsarfo/Developer/kone-wt/reviews/p4-forks-db3aa9a1.repro.test.ts`, test **F7 native fork snapshot drops system sender and prompt model stamp**. Against a real store and the same source/cut, compares `supportsFork:true` with `supportsFork:false`: portable retains `{kind:system}`, model and effort; native drops all three and labels the notice “User”. The repro asserts the defect and passes. Output: adjacent `p4-forks-db3aa9a1.repro.log`.

Preserve user-block sender and `copyTurnStamp` in this snapshot, as `buildHandoffImportedBlocks` in `handoff.ts` already does. Sharing the existing import builder would also avoid differences between these two paths.

## Disposition of the original six findings

| Finding | Status | Evidence |
| --- | --- | --- |
| F1: normal startup drops native target | Fixed | Common `startThread` now supplies the saved target. Corrected repro verifies normal startup and a same-provider first send without duplicate portable history. |
| F2: provider change receives foreign pointer | Fixed | Explicit cross-provider target uses portable import. Changing provider only at the first session/send clears the native pointer, and the real service delivers the imported ALPHA answer in its first-turn preamble. |
| F3: real restore never stamps rollback | Fixed | Real Git restore changes files back, stamps the boundary plus later turns, and fork refuses them. Dirty and missing-checkpoint refusals produce no stamps. Stamp is immediately after successful post-restore verification and before `ok:true` at `AgentService.ts:1829`. |
| F4: gateway bypasses service busy state | Fixed | Production IPC → gateway → tool wiring carries `isThreadBusy`. Adapted original in-flight-send repro uses this callback and verifies `isError` refusal and no fork row. |
| F5: Claude fork publishes source UUID | Fixed | Initial fork lifecycle has no source cursor. A controlled SDK feed produces the fork's own answer; real adapter/store persist its local UUID, then dispatcher/adapter resume the fork session with that UUID, without invoking `forkSession` again. |
| F6: omitted thread id cannot replay request | Fixed | Binding is resolved before minting an id. Identical assistant-target retry returns the first fork id with no error and only one mint. |

Original defect-assertion repros were rerun unchanged: the combined file has four expected failures (F1/F2/F3/F6), and the old Claude file fails for F5. The original F4 fixture omitted the new service callback, so it still accepts in the artificial unwired setup; the corrected fixture supplies the callback verified in the production wiring. These intentional old-repro failures are not gate regressions. All six corrected assertions pass.

## F3 interaction with P2

Read P2's `runRevert` at `p2-safety@2a8c1cde`, including final isolation/busy rechecks, directory claim, `finally` release and queued-work wake. Used `git merge-tree --write-tree p2-safety db3aa9a1`; no branch/worktree merge or source edit was performed. Output is saved as `reviews/p4-forks-db3aa9a1.p2-merge-tree.log`.

The simulated merge retains P4's stamp immediately before the single successful `return {ok:true}`, after P2's release/wake `finally`. Failure/refusal returns inside the claimed section execute release/wake and then return without reaching the stamp. `claimRestoreDir`'s release is synchronous; `kickTurnSlot` queues its drain through `prior.then(run)`. There is no await between release/wake and the synchronous stamp, so newly queued turns cannot start and be mistakenly included before stamping completes.

There are expected merge conflicts elsewhere in AgentService imports/history types, dispatcher, store and migration manifest. The restore-body stamp itself survives automatic merge; no finding there. Resolution must retain P2's protections and P4's history-store stamp method. Migration renumbering and a build/test gate of the resolved combined tip are still required; the simulated conflicted tree was not executed.

## Verification

Review-only tests outside the source tree, using Linux Bun 1.4.2 at `~/.local/bin/bun`:

- `reviews/p4-forks-db3aa9a1.repro.test.ts`: **13/0**. Covers F1/F2/F3/F4/F6 correct behavior, first-send provider change, native bootstrap suppression, refusal boundaries, generic finished outcomes, migrations, source rollback and the F7 defect.
- `reviews/p4-forks-db3aa9a1.claude-repro.test.ts`: **1/0**. F5 startup → own first answer → persisted fork-local cursor → resume.
- Existing targeted files: `dispatch.test.ts` **73/0**, `threadFork.test.ts` **15/0**, `agentCheckpoints.test.ts` **10/0**, `claudeGatewayInjection.test.ts` **7/0**, `gateway/tools/appForks.test.ts` **12/0**. Logs are `reviews/p4-forks-db3aa9a1.<file stem>.log` (gateway file uses `appForks`).
- `git diff --check 5c88bce7..db3aa9a1`: passes.

Inspected all pinned gate logs at `/home/gideonsarfo/Developer/kone-wt/gates/db3aa9a1-p4-forks-<step>.log`; each ends `# exit=0`:

| Gate | Exit | Result |
| --- | --- | --- |
| types | 0 | 5 tasks successful |
| lint | 0 | One existing unused-disable warning |
| agent-core | 0 | 2768/0 |
| protocol | 0 | 124/0 |
| git-core | 0 | 73/0 |
| desktop | 0 | 430/0 |
| web | 0 | 1498/0 |
| build | 0 | Both tasks successful, neither cached; 7m37.51s |

## Not checked / not done

Native forks remain **unit-tested only**: SDK/RPC behavior is mocked, no live provider fork/resume or paid provider call was made. No full suites/types/lint/build rerun by this reviewer; inspected the exact-pin logs and ran the targeted files above. No resolved P2/P4 combined runtime executed. No P5 work or renderer UI reviewed. No fixes, commits, merges, pushes or other-branch edits made. The prior accepted null/no-answer refusal remains correct and is still covered.

# P6a re-review

Verdict: **APPROVE**, pinned to **6da5ecc5481a4651c6bcb520f3da9c641795f5b9** (`6da5ecc5`).

Branch: `p6-queue`. Worktree: `/home/gideonsarfo/Developer/kone-wt/p6-queue`.
Reviewed the entire `6eb52914..6da5ecc5` diff (five commits, nine files), its store/gateway callers, the previous review, standing rules, and P6 requirements. Verified the pin before review and again at completion. No tracked worktree files changed.

## Findings

No new must-fix findings in this range. The three in-scope findings from `p6-queue-6eb52914.md` are confirmed fixed. Previous finding 4, user-attached references, belongs to 6b and is excluded from this verdict.

## Previous findings confirmed fixed

1. **100-hit store clamp defeating candidate widening — fixed.** `packages/agent-core/src/gateway/searchCollapse.ts:7` requests 100-row pages with an advancing offset; `store/search.ts:345` and `store/search.ts:355` implement the offset in scoped and global SQL. The original real-store failure scenario (101 higher-ranking unreadable hits hiding an eligible hit) now passes through the assistant mapping. A supplemental 950-candidate case uses offsets 0 through 900, filters 901 unreadable hits, and retains the eligible user block above earlier assistant item hits after collapse. Real-store tied-rank testing traverses 225 surviving hits after deleting 125 of 350 blocks: no repeated or missing identities at the 100/200 boundaries, in both scoped and global queries.
   Repros: `/home/gideonsarfo/Developer/kone-wt/reviews/p6-6da5ecc5-search-repro.test.ts` and `p6-6da5ecc5-queue-repro.test.ts` (tied-rank/page-offset test).

2. **Parent cannot search its cross-project spawned child — fixed.** `gateway/tools/appThreads.ts:1414` now includes target `parentThreadId`, matching the read boundary and shared rule. The original parent/child scenario passes. Supplemental assistant-mapped tests confirm an archived direct child remains searchable; a caller that is itself a child can search its parent and its own direct child; unrelated projects remain filtered.
   Repro: `/home/gideonsarfo/Developer/kone-wt/reviews/p6-6da5ecc5-search-repro.test.ts` (original parent-child repro and direct-lineage/archive test).

3. **Cancelled edited queue text remains searchable — fixed.** `store/queuedTurns.ts:491` clears the block FTS entry whenever the guarded prompt deletion actually removes a block. Both per-row cancellation (`:525`) and stop/bulk cancellation (`:584`) use `durably` around `atomically`. Edited old/new words disappear on cancellation. Bulk cancellation cleans queued and failed prompts, preserves a promoting prompt, and respects the `only` selector. A trigger rejecting the second block deletion rolls back the first deletion, its FTS removal, and all queue state changes. The existing per-row injected-delete failure likewise rolls back.
   Repros: `/home/gideonsarfo/Developer/kone-wt/reviews/p6-6da5ecc5-queue-repro.test.ts`; committed `packages/agent-core/src/conversationStore.queueEdit.test.ts`.

## Deletion/index and orphan audit

- `store/threads.ts:128` discards only an unadopted user prompt without a pending queue owner and unlists its FTS entry. Supplemental test checks physical FTS removal.
- `store/threadLifecycle.ts:249` deletes the entire thread subtree and calls `removeThreadRows` in the same transaction. Supplemental test checks parent/child results and an empty physical FTS table.
- All direct block DELETE statements in agent-core are in `threads.ts` and `queuedTurns.ts`; thread deletion cascades the remaining blocks/queue rows. Service per-row cancellation and scoped stop cancellation call these reviewed methods (`AgentService.ts:2628`, `:3764`). Promoting cancellation intentionally retains its prompt, because a running turn may own it.
- Edit-fork copies into a new thread, remints block IDs, and indexes the copy with `indexThreadRows` (`store/lineage.ts:698`); it does not delete the source prompt. Imported lineage indexes actual inserted block IDs inline (`:554`, `:569`). Turn-item indexing resolves the containing assistant block or uses NULL (`store/search.ts:142`). No legitimate copied-block reference is invalidated by the new join.
- Orphan exclusion is in SQL WHERE before ordering, LIMIT and OFFSET (`store/search.ts:345`, `:355`). It cannot consume a page slot and prematurely stop paging. Supplemental tests retain item hits with NULL and existing block IDs and reject a dangling non-NULL block ID in both scoped/global queries.

## Earlier verified fixes still hold

Quick reconfirmation of historical fixes 1–6, 8, and promotion side of 9:

- Queue edit retains order/state/creation/attempt fields, binds thread ownership and requires queued state in the UPDATE (`store/queuedTurns.ts:141`, `:191`). Existing and supplemental tests confirm omitted attachments/skills survive, explicit [] clears, and an injected block-update failure rolls queue/text back.
- Queue-list text contains actionable IDs/prompts; search text contains thread IDs/snippets. Supplemental tests stamp every tool `target:'assistant'`, assert structuredContent absent, and check text. All four false queue-control callbacks return `isError` with the concrete refusal reason. Production stamping remains at `gateway/index.ts:331`; registry stripping remains at `registry.ts:179`.
- Service edit still emits explicit [] and updates the existing queue row (`AgentService.ts:2770`). No renderer files changed in this range; the prior renderer verification is carried forward, not rerun.
- Promotion still checks thread ownership after its delivery wait and before claim (`AgentService.ts:2685`). Supplemental late edit/cancel after claim are refused and the promoted edited text remains indexed.
- Authorship still derives from sender metadata, with item hits treated as assistant hits (`store/search.ts:375`); imported-assistant and collapse regressions pass.

## Bounds and untested behavior

These existing bounds are retained, not new findings:

- Candidate collection stops at 1,000 raw surviving FTS hits (`gateway/searchCollapse.ts:10`). A readable hit or preferred user hit beyond that bound can still be omitted. This review confirms the previously intended bounded widening now reaches its cap; it does not claim exhaustive index-wide search.
- Cross-project lineage authorization is direct parent/child and source/fork only (`gateway/readScope.ts:37`, `:42`). Root-to-grandchild access without another allowance remains denied; the supplemental test explicitly confirms this. No transitive ancestry requirement was added in this range.
- Page-boundary tests use a stable database. Concurrent external writes between separate page queries were not exercised; OFFSET is not a snapshot cursor.
- Index helpers retain their existing best-effort error handling. Injected block-operation failures were checked, not storage corruption or an FTS-only write failure. The orphan filter prevents a dangling block reference from being returned even if an index row remains.

No fixes, other branches, UI exercise, live provider CLI, user-attached references, or merge/push. No independent rerun of full gates/build; inspected supplied logs on the exact pin. No broad audit of unrelated lineage or queue implementation beyond the interactions described above.

## Validation

Bun 1.4.2 at `/home/gideonsarfo/.local/bin/bun` (the Mac-specific `~/.bun/bin/bun` path is absent here). Ran each targeted file separately:

| File | Pass / fail |
| --- | --- |
| external `p6-6da5ecc5-search-repro.test.ts` | 6 / 0 |
| external `p6-6da5ecc5-queue-repro.test.ts` | 15 / 0 |
| `conversationStore.queueEdit.test.ts` | 13 / 0 |
| `conversationSearch.test.ts` | 15 / 0 |
| `gateway/searchRealStore.test.ts` | 2 / 0 |
| `gateway/searchCollapse.test.ts` | 6 / 0 |
| `gateway/readScope.test.ts` | 7 / 0 |
| `gateway/tools/appThreads.test.ts` | 96 / 0 |
| `conversationStore.editFork.test.ts` | 13 / 0 |

Total focused final runs: 173 pass, 0 fail. Expected injected-error diagnostics occur in rollback tests.

Repro adaptation: copied the previous files and corrected Mac absolute imports. Updated the old clamped fake store to honor the new offset contract. The first run of the copied search file had 49 pass/50 fail because it embedded unrelated old tests reading structuredContent despite stamping assistant targets; removed those embedded suites from the external focused copy, preserved the original three review repros, and added the edge tests above. These fixture failures are not production failures; the committed appThreads suite passes unchanged.

Supplied exact-pin gate logs inspected, each ending `# exit=0`:

| Gate | Log | Result |
| --- | --- | --- |
| types | `/home/gideonsarfo/Developer/kone-wt/gates/6da5ecc5-p6-queue-types.log` | exit 0 |
| lint | `/home/gideonsarfo/Developer/kone-wt/gates/6da5ecc5-p6-queue-lint.log` | exit 0 |
| agent-core | `/home/gideonsarfo/Developer/kone-wt/gates/6da5ecc5-p6-queue-agent-core.log` | 2785 / 0; exit 0 |
| protocol | `/home/gideonsarfo/Developer/kone-wt/gates/6da5ecc5-p6-queue-protocol.log` | 124 / 0; exit 0 |
| git-core | `/home/gideonsarfo/Developer/kone-wt/gates/6da5ecc5-p6-queue-git-core.log` | 73 / 0; exit 0 |
| desktop | `/home/gideonsarfo/Developer/kone-wt/gates/6da5ecc5-p6-queue-desktop.log` | 430 / 0; exit 0 |
| web | `/home/gideonsarfo/Developer/kone-wt/gates/6da5ecc5-p6-queue-web.log` | 1500 / 0; exit 0 |
| build | `/home/gideonsarfo/Developer/kone-wt/gates/6da5ecc5-p6-queue-build.log` | 2 tasks successful; exit 0 |

The contracting brief states build used `NODE_OPTIONS=--max-old-space-size=4096`; the log confirms success but does not itself record that environment variable.

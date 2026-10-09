P6a fix review — 6eb529140deb957bf630545d8783e63987761559
Verdict: changes requested.
Worktree: /Users/gideonsarfo/Developer/kone-wt/p6-queue
Base: 6a4bac3c. Reviewed fixes 14f3ed2, ebffe285 and test fixture changes through the pin. No tracked branch files edited.

Findings:

1. [P2] Candidate widening never gets past the real store's 100-hit limit (appThreads.ts:1396–1401; store/search.ts:394).
   The gateway requests 50/200/... candidates, but SearchRepo clamps every request to SEARCH_MAX_LIMIT=100. A 200 candidate request returns 100, so raw.length!==fetchLimit and the loop incorrectly considers the store exhausted. Default limit=20 starts with fetchLimit=160 and never widens at all. Real-store repro seeds 101 better-ranking unreadable hits and one eligible match; searchConversations(query,{limit:1000}) returns only 100; assistant-scoped app_search_threads reports no match. Finding 7 remains unfixed in production despite the uncapped fake-store regression passing. Allow internal candidate pagination/limits and perform scope/collapse/ranking before the result limit.

2. [P2] Search drops a parent's cross-project spawned child (appThreads.ts:1420–1422).
   canReadThread supports target.parentThreadId===callerThreadId, and app_read_thread passes that property, but search builds target with only projectPath/sourceThreadId. A parent therefore cannot search the child it can read. Assistant-scoped repro supplies a child whose parentThreadId names the caller, and receives "No conversations matched" instead of its snippet. Pass the target parent link into the shared scope rule.

3. [P2] Cancelled edited queue text remains searchable (queuedTurns.ts:489–494; store/search.ts:352).
   editQueuedTurn correctly replaces the FTS row inside its transaction. cancelQueuedTurn deletes the prompt block but deleteQueuedPromptBlock never removes its FTS row. Search's LEFT JOIN retains that orphan, classifying its missing sender as user-authored. Real-store repro: enqueue oldreviewword, edit to editedreviewword, cancel, search editedreviewword => hit for deleted ub-1. The old word is gone, but cancelled text is exposed as a conversation result with a dead jump target. The cleanup omission predates this patch; it remains a blocking interaction with the reviewed edit/index behavior and the explicitly requested cancellation audit. Remove the index row whenever cancellation actually deletes the prompt (both per-row and stop/bulk paths).

4. [P2, requirement gap by inspection] User-attached reference read scope is not wired (appThreads.ts:1416–1423; also readHandler:741).
   canReadThread defines attachedReferences and its pure test proves the allowance, but neither search nor read passes it; the only uses in this branch are that definition and the pure test. There is no persisted reference lookup or injected resolver on these tool calls. Thus unrelated cross-project reads remain conservatively denied even when a user-attached reference should authorize them. This is an unavailable allowed path, not a cross-project leak. Wire authoritative user-attached references at the boundary; do not trust a caller-supplied arbitrary id list.

Reconfirmation of earlier fixes:
1. Queue edit uses durably + atomically, state='queued' in the UPDATE, thread binding, preserves position/state/attempt/creation time. Supplemental failing-block SQL trigger confirms queue and old FTS text roll back on block-update error.
2. Queue-list/search content text carries actionable ids/prompts/snippets. Production index.ts stamps target:'assistant'; registry removes structuredContent for that target. Supplemental repros use that exact target and assert structuredContent absent before checking content text.
3. Omitted attachments/skills remain; explicit [] clears. Existing store regression passes.
4. Service emits explicit [] and renderer folds input/attachments/skills into existing chip. Existing web clear/edit regressions reviewed; web fixtures now carry createdAt. No queue reorder/reinsert in the edit service path.
5. Queue edit/cancel bind queue id and thread; promote checks ownership after its delivery wait before claim. Existing ownership tests pass.
6. False edit/cancel/reorder/promote callbacks raise refusal errors instead of success prose. Existing gateway tests pass.
7. Candidate widening code exists, but fails against real store clamp: finding 1 above. Parent/child shared scope also remains incomplete in search: finding 2 above.
8. Authorship reads blocks.sender_json through parseMessageSender. Imported system/agent/courier sender blocks rank below user-authored blocks; item hits remain assistant hits. Null/no sender and explicit user decode as user by existing protocol contract. Malformed/unknown sender JSON also defaults to user, matching the parser's documented legacy behavior. Existing imported-system and ordinary-user store tests and collapse tests pass.
9. Edited text replaces FTS text inside the queue-edit transaction and survives promotion. Supplemental late-edit/late-cancel after claim are refused and promoted edited text remains indexed. Cancellation cleanup is still broken: finding 3.

Read scope audit:
Own thread, own project, and direct fork/source links are represented in search. Child-to-parent works because caller.parentThreadId is passed. Parent-to-child is missing the target property. Unrelated projects are filtered. Global assistant sentinel bypasses project scope as intended. User-attached reference allowance has no tool-boundary wiring. The helper handles direct links only; no transitive ancestry walk is implemented.

Validation:
Ran existing tests sequentially and separately: queueEdit 9/0, conversationSearch 14/0, searchCollapse 6/0, readScope 7/0, appThreads 96/0 (132 passing focused agent-core tests). External repro files in reviews: p6-6eb52914-search-repro.test.ts (parent-child failure, clamped-stub failure, real-store clamp failure), p6-6eb52914-queue-repro.test.ts (cancel-index failure; promotion/state-guard and rollback checks pass). Web sessionReducer 28/0. External files pass oxlint. Original appThreads fixture tests remain unscoped; supplementary tests specifically stamp target:'assistant' to match production.

Gate explanation:
Reviewed supplied gate logs: types/lint/protocol/git-core/desktop/web exit 0. Agent-core's sole logged failure is stdio notifications/cancelled. My isolated rerun fails the same test twice (7/1 each) under installed Bun 1.2.16; Rill reports three isolated 8/0 runs and baseline pass. The proxy test, proxy script, and injection.ts are unchanged from baseline 6a4bac3c, and the test spawns the proxy against its own HTTP mock, so there is no observed connection to queue/search changes. Treat as runtime/timing instability, not a P6a regression; do not claim my isolated reruns passed.
Build failure was not rerun. Rill reproduced it on the untouched baseline and reports Nuxt client-manifest contention and font network timeouts. Accepted as a separate environment issue, not a P6a blocker.

No full suite/build, merging, pushing, live provider CLI, or UI exercise. Checked sibling backend search implementations for data/query context. P2 final test pin and P4/P3 pins remain pending separately.

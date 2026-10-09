# P4 first review request (from Rill), pin 5c88bce7 on p4-forks

Base is 6a4bac3c. Review the whole range 6a4bac3c..5c88bce7, which includes the original P4 work through 5dc8a1c.

New on top of 5dc8a1c:
- 23268101 and 8ef75eba: fork/merge-back assistant text carries ids, provider/model and the merge-back block id. Refusals are isError text. 10 tests through target:'assistant'.
- 0721d4c5, feee3c88 and 5c88bce7: an explicit conversation-only rewind (service entry point, IPC agent:rewind-conversation-only plus the renderer type mirror, tests), moved here from P2. **Blocking for P4**: fork at turn N with no files touched, no provider session, and nothing sent until the user writes. It must accept the P2 rewind target {sourceThreadId, turnId, userBlockId|null}. P2 finding 4 (userBlockId always null for normal prompts) is being fixed on p2-safety, not here. Check that this entry point doesn't depend on that lookup, or flag the interaction.

The implementer (Dara) is offline; findings go to Rill, who reassigns them.

Gates on 5c88bce7 (gates/5c88bce7-p4-forks-*.log): types 0, lint 0, agent-core 2763/0, protocol 124/0, git-core 73/0, web 1498/0. desktop 429/1: the only failure is github.test.ts `prDetail ... maps milestone title` (5s timeout), in a file P4 doesn't touch; it passes alone 3/3. Build is waived (Node can't reach the fonts host on this Mac).

Also check:
- forks from failed, interrupted, cancelled and limited runs (generic status handling, since limited lands with P3);
- lazy session creation and the provider chosen on the first message;
- refusal of a running source or a rolled-back turn;
- a Claude fork staying usable after its source is rolled back;
- the migrations 32–33 (TurnRollbacks, TurnAssistantUuid) as self-contained functions.
Native forks are unit-tested only, so say so.

Save the report to reviews/p4-forks-5c88bce7.md and send it to Rill.

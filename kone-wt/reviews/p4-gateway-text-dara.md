# P4 gateway-text audit — Dara's ledger note (for docs/t3code-parity.md under "Dara")

Dara could not edit the canonical ledger: the ~/Developer/kone checkout is
off-limits by standing rules. Rill, please paste the block below into
docs/t3code-parity.md under Dara, or treat this file as the note.

## Ledger block (paste under Dara / Phase 4)

- P4 gateway-text audit done on `p4-forks` @ `8ef75eba` (two new commits on top
  of frozen pin `5dc8a1c`):
  - `23268101` feat(gateway): fork/merge-back assistant text carries ids and
    reasons. Success texts now name the new thread id (`Thread id: …`), the
    provider/model the fork opens on, the "already exists" replay case in plain
    words, and the merge-back timeline block id (`Block id: …`). Refusal paths
    unchanged (isError `invalid_input` text) — they already named the reason.
  - `8ef75eba` test(gateway): fork/merge-back assistant-text audit through
    target assistant. All 10 cases go through the production `target:
    "assistant"` mapping (structuredContent stripped): success texts assert the
    ids/actionable data in text with no structured half; all six refusals
    (running source, rolled-back turn, unknown source, unknown turn, wrong
    source, unknown fork) assert isError + reason in text.
- Gates on `8ef75eba` (logs `~/Developer/kone-wt/gates/8ef75eba-p4-forks-*.log`,
  ledger `~/Developer/kone-wt/gates/ledger`): types 0, lint 0, agent-core 0
  (2758 pass, +7 vs pin's 2751 — the rewritten suite), protocol 0, git-core 0,
  desktop 0 (430 pass), web 0 (1498 pass), build 1 — `web#build` Nuxt
  `manifest.json` ENOENT after a clean client build. Identical failure on
  `p6-queue` (`6eb52914`, same ENOENT in its own worktree), so environmental /
  pre-existing, not from this change (agent-core gateway text only; all 1338
  web modules transform cleanly). Retried 3x incl. after clearing the Nuxt
  cache; consistent.
- No other P4 behaviour changed. Not done: live native forks still unprobed
  (unit-tested only); the `web#build` environment failure is not mine to fix
  from this branch.
- P5 design (no code, no branch) written to
  `~/Developer/kone-wt/reviews/p5-design.md`: queued switches as per-row
  selections delivered in queue order at turn end via hand-in; same-provider
  model/option rows ride the turn; per-provider+model remembered options table;
  model-change timeline mark beside the hand-in mark; self-switch gateway tool
  clamped to agent pin + availability + eligibility, isError refusals through
  the assistant mapping; position vs P1 budget and P4 forks; files + tests.

## Follow-up (Rill 2026-10-09): explicit conversation-only rewind

5dc8a1c did NOT have it: `forkThreadAtTurn` (lazy, no files, no session) was
reachable only through the gateway tool; the sole IPC fork
(`agent:fork-thread-at-block`) needs editedText and dispatches at once. Three
new commits on `p4-forks`:
- `0721d4c5` feat(agent-core): `AgentService.rewindConversationOnly` + the
  `RewindConversationOnlyInput` type (exactly the rewind target P2's
  shared-checkout refusal hands over, plus caller-minted ids; supportsFork
  resolved from the source's provider).
- `feee3c88` feat(desktop): `agent:rewind-conversation-only` IPC (straight to
  the service — a rewind starts no session, so nothing to dispatch), preload
  bridge, desktop.d.ts mirror.
- `5c88bce7` test(agent-core): 5 service tests — named userBlockId, null
  userBlockId (cuts at last answer block), running / rolled-back /
  unknown-source refusals; every one asserts nothing dispatched and no session
  started. Tip is `5c88bce7`.
- Gates on `5c88bce7` (logs `~/Developer/kone-wt/gates/5c88bce7-p4-forks-*.log`,
  `# exit=` trailers): types 0, lint 0, agent-core 0 (2763 pass, +5),
  protocol 0, git-core 0, desktop 0 (430 pass — first pass hit one flaky
  5s-timeout in github.test.ts prDetail, passes alone 24/0 and on re-run),
  web 0, build 1 (same pre-existing web#build Nuxt manifest ENOENT as on
  8ef75eba and p6-queue).
- Not done: renderer affordance calling the new IPC (backend only, out of
  scope); live native forks still unprobed.

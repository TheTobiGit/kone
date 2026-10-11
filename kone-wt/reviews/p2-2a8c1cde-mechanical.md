# P2 Mechanical Verification: 2a8c1cde

Pin: **2a8c1cde**
Worktree: `/home/gideonsarfo/Developer/kone-wt/p2-safety`
Runtime: Bun 1.4.2
Date: 2026-10-10

## Targeted Test Executions

Each targeted test file was executed independently with Bun 1.4.2 against `/home/gideonsarfo/Developer/kone-wt/p2-safety`. No tracked files were modified. Output and exit codes were recorded to external logs in `/home/gideonsarfo/Developer/kone-wt/reviews/`.

| Target File / Command | Log File | Exit | Results |
|---|---|:---:|---|
| `packages/agent-core/src/checkpointRestoreRace.test.ts` | `p2-2a8c1cde-restore-race.log` | 0 | 9 pass, 0 fail (23 expects) |
| `/home/gideonsarfo/Developer/kone-wt/reviews/p2-b37b836e-extra-restore-repro.test.ts` | `p2-2a8c1cde-extra-restore-repro.log` | 0 | 10 pass, 0 fail (23 expects) |
| `/home/gideonsarfo/Developer/kone-wt/reviews/p2-c5ae1d34-reservation-repro.test.ts` | `p2-2a8c1cde-reservation.log` | 0 | 13 pass, 0 fail (22 expects) |
| `/home/gideonsarfo/Developer/kone-wt/reviews/p2-c5ae1d34-turn-user-block-repro.test.ts` | `p2-2a8c1cde-turn-user-block.log` | 0 | 8 pass, 0 fail (17 expects) |
| `/home/gideonsarfo/Developer/kone-wt/reviews/p2-b37b836e-promoted-before-ack.test.ts`<br>FILTER `-t 'promotion before\|real service can'` | `p2-2a8c1cde-promoted-before-ack.log` | 0 | 2 pass, 0 fail, 13 filtered (6 expects) |
| `packages/agent-core/src/checkpointRestoreSafety.test.ts` | `p2-2a8c1cde-restore-safety.log` | 0 | 10 pass, 0 fail (25 expects) |
| `packages/agent-core/src/agentCheckpoints.test.ts` | `p2-2a8c1cde-checkpoints.log` | 0 | 12 pass, 0 fail (41 expects) |
| `packages/agent-core/src/agentSafety.review2.test.ts` | `p2-2a8c1cde-review2.log` | 0 | 12 pass, 0 fail (20 expects) |
| `packages/agent-core/src/conversationStore.turnUserBlock.test.ts` | `p2-2a8c1cde-turn-user-committed.log` | 0 | 7 pass, 0 fail (14 expects) |
| `packages/agent-core/src/threadSpawn.test.ts`<br>FILTER `-t 'startup'` | `p2-2a8c1cde-startup.log` | 0 | 2 pass, 0 fail, 105 filtered (17 expects) |
| `packages/agent-core/src/gateway/registry.test.ts`<br>FILTER `-t 'assistant tool'` | `p2-2a8c1cde-assistant.log` | 0 | 4 pass, 0 fail, 19 filtered (11 expects) |
| `/home/gideonsarfo/Developer/kone-wt/reviews/p2-2a8c1cde-enqueue-failure-repro.test.ts`<br>FILTER `-t 'enqueue failure'` | `p2-2a8c1cde-enqueue-failure-repro.log` | 1 | 0 pass, 2 fail, 9 filtered (2 expects) |
| `/home/gideonsarfo/Developer/kone-wt/reviews/p2-2a8c1cde-steer-handoff-repro.test.ts`<br>FILTER `-t 'steer that becomes'` | `p2-2a8c1cde-steer-handoff-repro.log` | 1 | 0 pass, 1 fail, 9 filtered (1 expect) |

## Supplied Gate Logs (`gates/2a8c1cde-p2-safety-*.log`)

Location: `/home/gideonsarfo/Developer/kone-wt/gates/`

| Gate Log File | Command / Header | Exit | Footer Counts / Summary |
|---|---|:---:|---|
| `2a8c1cde-p2-safety-build.log` | `bun run build --concurrency=1`<br>`$ turbo run build "--concurrency=1"` | 0 | Tasks: 2 successful, 2 total (0 cached)<br>Time: 6m6.053s |
| `2a8c1cde-p2-safety-types.log` | `turbo run check-types` | 0 | Tasks: 5 successful, 5 total (0 cached)<br>Time: 1m39.02s |
| `2a8c1cde-p2-safety-lint.log` | `bun run lint`<br>`$ oxlint --report-unused-disable-directives` | 0 | Exit 0 |
| `2a8c1cde-p2-safety-agent-core.log` | `cd packages/agent-core && bun test` | 0 | 2699 pass, 0 fail (8270 expects, 157 files)<br>Time: 78.71s |
| `2a8c1cde-p2-safety-protocol.log` | `cd packages/protocol && bun test` | 0 | 124 pass, 0 fail (414 expects, 13 files)<br>Time: 145.00ms |
| `2a8c1cde-p2-safety-git-core.log` | `cd packages/git-core && bun test` | 0 | 73 pass, 0 fail (227 expects, 8 files)<br>Time: 4.21s |
| `2a8c1cde-p2-safety-desktop.log` | `cd apps/desktop && bun test` | 0 | 405 pass, 0 fail (865 expects, 38 files)<br>Time: 21.31s |
| `2a8c1cde-p2-safety-web.log` | `cd apps/web && bun test` | 0 | 1498 pass, 0 fail (5091 expects, 114 files)<br>Time: 5.34s |

# Standing rules for t3code parity work (Mac, from 2026-10-09)

Coordinator and lead: **Rill**. Send everything you need acted on to Rill as a `question` or `report`, never a `note`.

- Read first: ~/Developer/kone/docs/t3code-parity.md (ledger), docs/t3code-parity-phases.md (requirements), docs/t3code-parity-resume.md, then ~/Developer/kone/CLAUDE.md and AGENTS.md. The t3code reference repo is at ~/Developer/opensource/t3code (mostly apps/server/src/orchestration-v2). Borrow ideas, not code.
- Work only in your assigned worktree under ~/Developer/kone-wt/. Check `git branch --show-current` and the tip before editing. Every instruction names a commit; if the tip has moved past it, tell Rill rather than redoing work.
- Never touch linux/desktop-shell or the ~/Developer/kone checkout. No push, no force-push, no amend, no rebase of a branch under review. Findings land as new commits. Old pins stay reachable.
- Bun: use `~/.bun/bin/bun` (1.4.x). `/usr/local/bin/bun` is an old 1.2.16 and gives different test results; put `~/.bun/bin` first on PATH for targeted test runs.
- Gates: run them only through `~/Developer/kone-wt/gate.sh <steps>` from inside your worktree (steps: types lint agent-core protocol git-core desktop web build, or all). It holds the shared machine-wide lock, needs a clean committed tree, and logs to ~/Developer/kone-wt/gates/<sha>-<branch>-<step>.log. Run it in the foreground and wait for it in the same turn. Never run bun test suites or check-types outside it, except a single targeted test file (`bun test path/to/file.test.ts`). Known flaky test on the baseline: the OpenCode warm-spare test (passes alone). Any other failure is real until shown otherwise.
- Gateway tools: for the production assistant target, `structuredContent` is stripped. Everything an agent needs (ids, snippets, refusal reasons) must be in the text. Refusals are `isError` text. Test every tool through the `target:'assistant'` mapping.
- Migrations: add each one as a single self-contained function. Do not renumber it yourself; Rill renumbers at merge.
- Kone is unreleased: no back-compat shims or legacy-data branches. Backend only: no new visual UI.
- Keep AgentService.ts edits small; put new logic in new modules with tests next to them (*.test.ts), in the existing style.
- Code comments: match the density and naming of the surrounding code. **Never cite an outside source in a comment** (no "borrowed from t3code", no "the reference does X"). Keep the reasoning, drop the citation.
- Before asking for review, self-check: failure/cancel/interrupt paths; concurrent writers and transactions; tool output as the agent sees it; the search index and event payloads after edits; migration numbering.
- You may start small workers for lookups and single scoped edits (Claude Haiku 4.5, Codex GPT-6 Luna, Gemini 3.8 Flash), never for a whole phase. At most a few at once.
- Every report states: branch, exact commit, gate results on that commit (log paths and exit codes), and what is NOT done.

# Resume t3code parity on the Mac (after the Linux session, 2026-10-11)

Give this to the coordinating agent. It replaces the Linux resume instruction of 2026-10-09. The phase plan (`docs/t3code-parity-phases.md`), the user's scope decisions, the lead decisions in `docs/t3code-parity.md` and the rules in `kone-wt/RULES.md` still govern. Push only what the user authorizes.

## 1. Get the docs and tooling

```sh
cd ~/Developer/kone
git fetch origin
git archive origin/parity-handoff docs | tar -x            # ignored planning docs -> docs/
git archive origin/parity-handoff kone-wt | tar -x -C ..   # gate.sh, RULES.md, reviews/, gates/
chmod +x ../kone-wt/gate.sh; touch ../kone-wt/.gate.lock
```

`docs/agent-delivery-design.md` and `docs/agent-roles-design.md` on parity-handoff are the Mac handoff copies; if the Mac checkout has newer local edits to either, keep yours (`--exclude` them from the tar). Merge the kone-wt archive into any existing `~/Developer/kone-wt`; don't overwrite newer local reviews.

Read `docs/t3code-parity.md`, section **"Linux session (2026-10-10/11)"** (current state, top of the ledger), then `docs/t3code-parity-phases.md`, `../kone-wt/RULES.md`, `CLAUDE.md`, `AGENTS.md`.

## 2. Worktrees: fast-forward to the pushed pins

```sh
for b in t3-parity p2-safety p3-limits p4-forks p6-queue p7b-handoff-wip; do
  d=../kone-wt/$b; [ "$b" = t3-parity ] && d=../kone-wt/integration
  if [ -d "$d" ]; then git -C "$d" status --short; git -C "$d" merge --ff-only "origin/$b";
  else git worktree add --track -b "$b" "$d" "origin/$b" 2>/dev/null || git worktree add "$d" "$b"; fi
  (cd "$d" && bun install --frozen-lockfile)
done
```

Expected tips: t3-parity `6a4bac3c`, **p2-safety `b595bdce`**, **p6-queue `6da5ecc5`**, **p4-forks `fd980fa2`**, p3-limits `70592fc0`, p7b-handoff-wip `5f687467`. The Mac worktrees may still have uncommitted WIP from the power cut (p2-safety, p6-queue); that WIP was finished on Linux as proper commits, so discard it (`git -C <wt> stash` first if unsure) before fast-forwarding. The `origin/mac-wip/*` refs are obsolete.

## 3. Tooling

- `gate.sh` is now **bash** (works with macOS bash 3.2; uses `flock` if present, else `lockf`). It puts `~/.bun/bin` then `~/.local/bin` first on PATH and builds with `--concurrency=1` (web and desktop otherwise race on the shared Nuxt cache: `manifest.json` ENOENT).
- Build: on Linux the default Node heap OOMs `web#build`; use `NODE_OPTIONS=--max-old-space-size=4096 ~/Developer/kone-wt/gate.sh build`. On the Mac, the build was waived because Node couldn't reach fonts.gstatic.com; try it with `--concurrency=1` and the larger heap, and say if it is still the fonts fetch.
- Workers (user, 2026-10-10): use **OpenCode Muse Spark 1.3 Free** (`opencode/muse-spark-1.3-contributor-free`) or **Antigravity Gemini 3.8 Flash** (must be started full-access) for mechanical work; keep Claude and Codex for coordination, hard fixes and reviews. The pay-per-use `opencode/` models are out of funds. Withdraw any worker that loops on "fetch failed".

## 4. Next actions, in order

1. **P2** (p2-safety `b595bdce`): gated (all 0 except build, which did not run before the session ended; run `gate.sh build`). Needs its **fourth review** of `2a8c1cde..b595bdce` (two fixes for Wren's round-3 findings: enqueue-failure fallback and in-flight steers; see the ledger). Wren's audit listed every direct adapter call; these were the last two. Approve → merge first.
2. **P6a** (p6-queue `6da5ecc5`): **APPROVED** (Ines, `reviews/p6-queue-6da5ecc5.md`). Merge right after P2.
3. **P4** (p4-forks `fd980fa2`): F1–F6 fixed (Selin) and confirmed by Tobias at db3aa9a1; F7 fixed in `fd980fa2` (native fork snapshot keeps sender and turn stamp). Gated all 0 except build (not run). Needs Tobias-style confirmation of F7 only, then merge after P3.
4. Merge into t3-parity in order P2 → P6a → P3 → P4. Renumber migrations at each merge (P2 Continuations → 32, P3 LimitAndSnooze → 33, P4 TurnRollbacks/TurnAssistantUuid → 34/35; confirm against the destination manifest) and gate the combined tip including the build.
5. Then P3 (carry onto the new base first; unreviewed), P7b, 6b (incl. user-attached references), P5 (design approved), P8, P9.

## 5. Rules worth repeating

- Pin every review to a commit. Findings land as new commits; no amend, rebase or force-push.
- Heavy gates only through `kone-wt/gate.sh`, one at a time, foreground (or a background run you wait for). Don't edit a worktree while its gate runs.
- Gateway text is what the global assistant sees (target:'assistant' strips structuredContent). Refusals are isError text.
- Never cite an outside source in a code comment.
- Anything an agent must act on goes as a question or report (or an agent_followup), never a note: notes wait for a turn that may never come.
- Leave `linux/desktop-shell` and the main checkout alone. Keep teamwork separate.

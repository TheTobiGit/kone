# Resume t3code parity on Linux (after the Mac power cut, 2026-10-09)

Give this to the new coordinating agent. It replaces the earlier Mac resume instruction. The phase plan, earlier user scope decisions and the rules in `kone-wt/RULES.md` still govern. Pushing is limited to what the user authorizes: new phase commits stay local unless the user says otherwise.

## 1. Get the docs and tooling

```sh
cd ~/Developer/kone
git fetch origin
git show origin/parity-handoff:T3CODE-PARITY-RESUME.md | less   # this file
mkdir -p docs ../kone-wt
git archive origin/parity-handoff docs | tar -x            # ignored planning docs -> docs/
git archive origin/parity-handoff kone-wt | tar -x -C .. --strip-components=0
# The second command creates ../kone-wt/{gate.sh,RULES.md,reviews/,gates/}. Merge it with any
# existing ~/Developer/kone-wt; don't overwrite newer local reviews.
chmod +x ../kone-wt/gate.sh; touch ../kone-wt/.gate.lock; mkdir -p ../kone-wt/gates
```

Read `docs/t3code-parity.md`, section **"Back to Linux after the Mac power cut"**, which has the pinned refs, findings, decisions and lessons. Then read `docs/t3code-parity-phases.md`, `../kone-wt/RULES.md`, `CLAUDE.md` and `AGENTS.md`.

`RULES.md` was written on the Mac. On Linux, read its t3code path as wherever t3code lives (formerly `~/Developer/opensource/t3code`). gate.sh uses `flock` automatically when it's installed.

## 2. Worktrees

The Linux machine may still have the old worktrees at older pins. Inspect them first, keep any uncommitted edits, and then fast-forward:

```sh
for b in t3-parity p2-safety p3-limits p4-forks p6-queue p7b-handoff-wip; do
  d=../kone-wt/$b; [ "$b" = t3-parity ] && d=../kone-wt/integration
  if [ -d "$d" ]; then git -C "$d" status --short; git -C "$d" merge --ff-only "origin/$b";
  else git worktree add --track -b "$b" "$d" "origin/$b" 2>/dev/null || git worktree add "$d" "$b"; fi
  (cd "$d" && bun install --frozen-lockfile)
done
```

Expected tips: t3-parity `6a4bac3c`, p2-safety `1f7550ec`, p6-queue `4d4de1e6`, p4-forks `5c88bce7`, p3-limits `70592fc0`, p7b-handoff-wip `5f687467`. If a tip differs, someone moved it; inspect before acting.

Check `bun --version` (the repo pins 1.3.13) and make sure the bun that gate.sh finds first is a current one.

## 3. Unfinished work in mac-wip refs

`origin/mac-wip/p2-safety` (`b7126ba4`) and `origin/mac-wip/p6-queue` (`201cc642`) are snapshots of uncommitted edits taken when the power went: one commit on top of each branch tip. They are unreviewed and may be half done.

For each, run `git diff <branch> origin/mac-wip/<branch>`. Then finish the work in the branch worktree as proper small commits with tests. Never fast-forward a branch to the WIP snapshot.

## 4. Next assignments, in order

1. **P2** (p2-safety): finish finding 1 (restore race; the WIP likely has it) and finding 4 (userBlockId lookup, not started). Then gate the tip and get an independent re-review of the range 7b87bba..tip. Fold in the earlier findings 2 and 3 commits.
2. **P6a** (p6-queue): finish finding 3 (cancelled queue text in FTS, all cancel paths, skip orphan rows; the WIP likely has part of it). Then gate and re-review.
3. **P4** (p4-forks @ 5c88bce7, already gated): first review per `kone-wt/reviews/p4-review-request-5c88bce7.md`. The conversation-only rewind is blocking.
4. Merge into t3-parity as each phase is approved: P2 → P6a → P3 → P4. Renumber migrations at each merge and gate the combined tip, including the build.
5. Then P3 (carry it onto the new base first), P7b, 6b (including user-attached references), P5 (design approved), P8, P9.

## 5. Rules worth repeating

- Pin each review to a commit. Findings land as new commits; no amend, rebase or force-push under review.
- Heavy gates run one at a time through `kone-wt/gate.sh` in the foreground. Don't edit a worktree while its gate runs.
- Gateway text is what the global assistant sees (target:'assistant'). Refusals are isError text.
- Never cite an outside source in a code comment.
- Anything an agent must act on goes as a question or report, never a note. Address agents by thread id when two share a name.
- Leave `linux/desktop-shell` alone. Keep teamwork separate.

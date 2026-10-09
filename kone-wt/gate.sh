#!/bin/zsh
# Usage: ~/Developer/kone-wt/gate.sh <step> [<step>...]   (run from inside a worktree)
# Steps: types lint agent-core protocol git-core desktop web build all
# Every step holds the shared lock, so only one heavy gate runs on this machine at a time.
# Each step writes gates/<short-sha>-<branch>-<step>.log and appends "<sha> <branch> <step> exit=<n>" to gates/ledger.
set -u
# Agents start with different PATHs and may find an old system bun first; pin the user install.
export PATH="$HOME/.bun/bin:$PATH"
root=$(git rev-parse --show-toplevel) || exit 2
cd "$root"
if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  echo "gate: uncommitted changes to tracked files; commit first so the log names a real commit" >&2
  exit 2
fi
sha=$(git rev-parse --short=8 HEAD)
branch=$(git branch --show-current)
dir=~/Developer/kone-wt/gates
steps=("$@")
[[ ${#steps} -eq 0 || "${steps[1]}" == all ]] && steps=(types lint agent-core protocol git-core desktop web build)
worst=0
# macOS ships lockf; Linux has flock. Both hold an exclusive lock for the command's lifetime.
if command -v flock >/dev/null; then locker=(flock); else locker=(lockf -k); fi
for s in $steps; do
  case $s in
    types) cmd=(bun run check-types) ;;
    lint) cmd=(bun run lint) ;;
    agent-core|protocol|git-core) cmd=(zsh -fc "cd packages/$s && bun test") ;;
    desktop|web) cmd=(zsh -fc "cd apps/$s && bun test") ;;
    build) cmd=(bun run build) ;;
    *) echo "gate: unknown step $s" >&2; exit 2 ;;
  esac
  log="$dir/$sha-$branch-$s.log"
  echo "gate: $s on $branch@$sha (waiting for lock)"
  "${locker[@]}" ~/Developer/kone-wt/.gate.lock zsh -fc '
    log=$1; shift
    { echo "# $(date -u +%FT%TZ) $PWD bun $(bun --version) $*"; "$@"; } >"$log" 2>&1
    code=$?
    echo "# exit=$code" >>"$log"
    exit $code' _ "$log" $cmd
  code=$?
  # A step only counts for the commit it names: the tree must not change under it.
  if [[ "$(git rev-parse --short=8 HEAD)" != "$sha" || -n "$(git status --porcelain --untracked-files=no)" ]]; then
    echo "# INVALID: worktree changed during this step" >>"$log"
    code=99
  fi
  echo "$sha $branch $s exit=$code $(date -u +%FT%TZ)" >>"$dir/ledger"
  echo "gate: $s exit=$code  log=$log"
  tail -5 "$log"
  (( code > worst )) && worst=$code
done
exit $worst

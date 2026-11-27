#!/usr/bin/env bash
#
# The gate. Four checks, one exit code, one verdict line.
#
# 🛑 `npm test` ALONE IS NOT THE GATE. It passes while the tree is unbuilt,
# untypechecked and unformatted. PR 457 merged on a true "npm test EXIT 0,
# 2821/2821" and put `main` red on format:check, which blocks EVERY agent's
# gate until a second PR fixes it.
#
# Run it as `npm run gate`. This file is the body; that is the name.
#
set -euo pipefail

# Derived, never hardcoded: a path to one worktree is why the previous
# gate script could not be run by the agent in the other one.
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

ALLOW_DIRTY=0
for arg in "$@"; do
  case "$arg" in
    --allow-dirty) ALLOW_DIRTY=1 ;;
    -h|--help)
      echo "usage: npm run gate [-- --allow-dirty]"
      echo "  build + typecheck + format:check + test, with a verdict."
      echo "  --allow-dirty  gate a tree with uncommitted edits."
      exit 0
      ;;
    *) echo "gate: unknown argument: $arg" >&2; exit 2 ;;
  esac
done

# Per-test ceiling. The 15h hang was ONE test awaiting a supervisor that threw
# before it was bound, so a per-test timeout is what ends it.
TEST_TIMEOUT_MS="${GATE_TEST_TIMEOUT_MS:-60000}"
# Whole-run ceiling. A per-test timeout cannot end a run whose tests all
# finished and whose process will not exit, which is a different hang.
WALL_SECONDS="${GATE_WALL_SECONDS:-1800}"

LOG="${GATE_LOG:-/tmp/gate-$(basename "$REPO").log}"

say() { printf '%s\n' "$*"; }
step() { say ""; say "── $* ───────────────────────────────"; }

if [ "$ALLOW_DIRTY" -eq 0 ]; then
  step "tree"
  if [ -n "$(git status --porcelain)" ]; then
    say "🛑 REFUSING: the working tree is dirty."
    say ""
    git status --short
    say ""
    say "A gate run against uncommitted edits reports on a tree that will"
    say "never be pushed. Commit, stash, or pass --allow-dirty."
    exit 3
  fi
  say "clean at $(git rev-parse --short HEAD)"
fi

for s in build typecheck format:check; do
  step "npm run $s"
  npm run "$s"
done

step "npm test"
say "per-test timeout ${TEST_TIMEOUT_MS}ms · wall ceiling ${WALL_SECONDS}s"
say "transcript: $LOG"

# `>` not `>>`: one log per worktree, overwritten each run.
: > "$LOG"

set +e
npm test -- --test-timeout="$TEST_TIMEOUT_MS" >"$LOG" 2>&1 &
TEST_PID=$!

( sleep "$WALL_SECONDS"; kill -0 "$TEST_PID" 2>/dev/null && kill -9 "$TEST_PID" 2>/dev/null ) &
KILLER_PID=$!

wait "$TEST_PID"
TEST_STATUS=$?
kill "$KILLER_PID" 2>/dev/null
set -e

tail -40 "$LOG"

step "verdict"

# 🛑 The parser THROWS on a missing totals block rather than reporting zeroes.
# A run killed by the wall ceiling printed no failures, and that is not a pass.
if ! VERDICT="$(node --input-type=module -e "
  import { readFileSync } from 'node:fs';
  import { parseTestTotals, verdictFor } from '$REPO/scripts/lib/gate-totals.mjs';
  const t = parseTestTotals(readFileSync('$LOG', 'utf8'));
  const v = verdictFor(t);
  const line = ['tests','pass','fail','cancelled','skipped','todo']
    .map((k) => k + ' ' + t[k]).join(' · ');
  process.stdout.write(line + '\n' + (v.ok ? 'GREEN' : 'RED') + ' — ' + v.reason + '\n');
  process.exit(v.ok ? 0 : 1);
" 2>&1)"; then
  say "$VERDICT"
  say ""
  say "🛑 GATE RED. Full transcript: $LOG"
  exit 1
fi

say "$VERDICT"

if [ "$TEST_STATUS" -ne 0 ]; then
  say ""
  say "🛑 GATE RED: the totals are green but npm test exited $TEST_STATUS."
  say "   Something failed outside the tests themselves. Read $LOG."
  exit 1
fi

say ""
say "✅ GATE GREEN — build · typecheck · format:check · test"

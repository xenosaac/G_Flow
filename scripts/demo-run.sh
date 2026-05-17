#!/usr/bin/env bash
#
# G_Flow Hackathon V1 — local demo runner.
#
# Walks Phase 1 (Planner) and Phase 2 (orchestrator loop) end-to-end against a
# sibling `../demo-target/` project (override via GFLOW_TARGET_DIR).
#
# Usage:
#   scripts/demo-run.sh                              # default goal
#   scripts/demo-run.sh "build a kanban board with…"  # custom goal
#
# Requirements:
#   - bun on PATH
#   - claude CLI on PATH (or set GFLOW_BACKEND=mock for a dry run)
#   - Playwright Chromium installed (`bunx playwright install chromium`)
#
# In a second terminal: bun run console:dev   →   http://localhost:3030

set -euo pipefail

GFLOW_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="${GFLOW_TARGET_DIR:-"${GFLOW_DIR}/../demo-target"}"
GOAL="${1:-build a minimal todo app with email signup, login, persisted todos, and a logout button}"

echo "[demo-run] G_Flow root:    $GFLOW_DIR"
echo "[demo-run] Worker target:  $TARGET"
echo "[demo-run] Goal:           $GOAL"
echo

if [ ! -d "$TARGET" ]; then
  echo "[demo-run] Creating empty target dir: $TARGET"
  mkdir -p "$TARGET"
  (
    cd "$TARGET"
    git init -q
    printf "# demo-target\n\nWorker sandbox. Edited by G_Flow Phase 2 runs.\n" > README.md
    git add README.md
    git -c user.email=gflow@local -c user.name="G_Flow demo" commit -q -m "initial commit"
  )
  echo "[demo-run]   git-initialized empty repo."
fi

cd "$GFLOW_DIR"

if [ "${GFLOW_BACKEND:-claude-code}" = "claude-code" ] && ! command -v claude >/dev/null 2>&1; then
  echo "[demo-run] WARNING: GFLOW_BACKEND=claude-code but \`claude\` is not on PATH."
  echo "[demo-run]          Either install Claude Code or run with GFLOW_BACKEND=none."
fi

echo "[demo-run] -- Phase 1 -- Planner"
bun bin/gflow start "$GOAL"

LATEST=$(ls -t .gflow 2>/dev/null | head -1 || true)
if [ -n "$LATEST" ] && [ -f ".gflow/$LATEST/contract.yaml" ]; then
  echo
  echo "[demo-run]   Contract written:"
  echo "[demo-run]   $(pwd)/.gflow/$LATEST/contract.yaml"
  echo "[demo-run]   Inspect it, then approve to begin Phase 2."
else
  echo
  echo "[demo-run] No contract.yaml was written (likely missing backend)."
  echo "[demo-run] To dry-run without an LLM:"
  echo "[demo-run]   GFLOW_BACKEND=none bun bin/gflow start \"\$GOAL\""
  exit 1
fi

echo
read -r -p "[demo-run] Press Enter to approve and run Phase 2 (Ctrl-C to abort)…" _
bun bin/gflow resume

echo
echo "[demo-run] Done. Check:"
echo "[demo-run]   bun bin/gflow status"
echo "[demo-run]   open http://localhost:3030     # if console:dev is running"

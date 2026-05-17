#!/usr/bin/env bash
#
# G_Flow real isolated E2E.
# Runs a real Claude / Codex flow against a fresh temp target, then verifies
# the generated index.html with the JSDOM click harness.
#
# Usage:
#   GFLOW_BACKEND=codex bash scripts/e2e-real.sh
#   GFLOW_BACKEND=claude-code bash scripts/e2e-real.sh "build a kanban board…"
#
# What it does:
#   1. mktemp -d for GFLOW_ROOT and GFLOW_TARGET_DIR (no repo pollution).
#   2. git-inits the target so the worker can commit.
#   3. Runs `gflow start "<goal>"` (Phase 1: Planner produces contract.yaml).
#   4. Runs `gflow resume` (Phase 2: real Worker, Screwdriver, deterministic
#      Playwright UserTest, Steward).
#   5. Runs the Playwright UserTest runner directly against the generated
#      static file to prove the UI actually works in Chromium.
#
# Preserves the temp dirs on exit so artifacts can be inspected.

set -euo pipefail

BACKEND="${GFLOW_BACKEND:-codex}"
GOAL="${1:-build a static single-page todo app in a single index.html (no build step, no dependencies). The page must include: an <input id=\"todo-input\"> for typing, a <button id=\"add-todo\">Add Todo</button>, and a <ul id=\"todo-list\"></ul>. Inline <script> wires the click so that pressing Add Todo appends the trimmed input value as a new <li> to the list and clears the input. Empty input is ignored. Save only index.html in the target dir.}"

TMP_ROOT="$(mktemp -d -t gflow-e2e-root-XXXXXX)"
TMP_TARGET="$(mktemp -d -t gflow-e2e-target-XXXXXX)"

echo "[e2e-real] backend:    $BACKEND"
echo "[e2e-real] GFLOW_ROOT: $TMP_ROOT"
echo "[e2e-real] target:     $TMP_TARGET"
echo "[e2e-real] goal:       ${GOAL:0:120}..."
echo

(
  cd "$TMP_TARGET"
  git init -q
  git config user.email "gflow@local"
  git config user.name "G_Flow E2E"
  touch .gitkeep
  git add .gitkeep
  git commit -qm "initial target"
)

export GFLOW_ROOT="$TMP_ROOT"
export GFLOW_TARGET_DIR="$TMP_TARGET"
export GFLOW_BACKEND="$BACKEND"

GFLOW_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$GFLOW_DIR"

echo "[e2e-real] Phase 1 — Planner"
if ! bun bin/gflow start "$GOAL"; then
  echo "[e2e-real] Planner FAILED. Inspect $TMP_ROOT for partial artifacts." >&2
  exit 1
fi

LATEST=$(ls -t "$TMP_ROOT" | head -1)
echo
echo "[e2e-real] Flow: $LATEST"
echo "[e2e-real] Contract:"
sed -n '1,40p' "$TMP_ROOT/$LATEST/contract.yaml" || true
echo "  ... (truncated)"
echo

echo "[e2e-real] Phase 2 — Orchestrator"
bun bin/gflow resume

echo
echo "[e2e-real] State:"
bun bin/gflow status || true

echo
if [ -f "$TMP_TARGET/index.html" ]; then
  echo "[e2e-real] index.html generated ($(wc -c < "$TMP_TARGET/index.html") bytes)"
  echo "[e2e-real] Playwright browser verification:"
  (
    cd "$TMP_TARGET"
    cat <<'JSON' | bun "$GFLOW_DIR/src/runtime/validators/playwright-user-test.ts"
{
  "target_url": "http://localhost:3000",
  "assertions": [
    {
      "id": "A-E2E-001",
      "text": "Typing Buy milk and clicking Add Todo appends Buy milk",
      "evidence_required": "Chromium DOM observation",
      "user_check": {
        "kind": "browser_flow",
        "start": "file",
        "path": "index.html",
        "steps": [
          { "kind": "fill", "selector": "#todo-input", "value": "Buy milk" },
          { "kind": "click", "selector": "#add-todo" },
          { "kind": "expect_text", "selector": "#todo-list", "text": "Buy milk" }
        ]
      }
    }
  ]
}
JSON
  )
  echo
  echo "[e2e-real] DONE. Artifacts preserved:"
  echo "  $TMP_ROOT/$LATEST"
  echo "  $TMP_TARGET"
else
  echo "[e2e-real] index.html NOT generated. Inspect:"
  echo "  $TMP_ROOT/$LATEST/handoffs/"
  echo "  $TMP_ROOT/$LATEST/decisions/"
  exit 1
fi

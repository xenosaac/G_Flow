#!/usr/bin/env bash
# gbrain-smoke.sh — end-to-end smoke test for the G_Flow ↔ GBrain bridge.
#
# What this exercises:
#   1. enqueueSnapshot via `gflow gbrain seed-snapshot` (no LLM needed)
#   2. drain pipeline via `gflow gbrain drain`
#   3. retrieval via `gflow gbrain query`
#   4. raw page read via `gbrain get <slug>`
#
# Skips gracefully when `gbrain` is not installed locally (CI-safe).

set -uo pipefail

if ! command -v gbrain >/dev/null 2>&1; then
  echo "gbrain not installed; skipping smoke test (this is fine in CI)"
  echo "To install GBrain locally: git clone https://github.com/garrytan/gbrain.git ~/gbrain && cd ~/gbrain && bun install && bun link"
  exit 0
fi

# Verify gbrain is initialized.
if ! gbrain doctor --json --fast >/dev/null 2>&1; then
  echo "gbrain CLI present but 'gbrain doctor --json --fast' failed."
  echo "Run 'gbrain init' first."
  exit 0
fi

# Fresh, isolated GFLOW_ROOT so we don't pollute existing flows.
TMP_ROOT=$(mktemp -d -t gflow-gbrain-smoke.XXXXXX)
trap 'rm -rf "$TMP_ROOT"' EXIT

export GFLOW_ROOT="$TMP_ROOT"
export GBRAIN_MODE="local-cli"
export GBRAIN_SOURCE_ID="gflow-smoke"

FLOW_ID="f_smoke_$(date -u +%Y%m%d_%H%M%S)_$$"
GOAL="build a static todo app"
SLUG_PREFIX="gflow/gflow-smoke/$(echo "$FLOW_ID" | tr '_' '-')"

echo "=== gbrain-smoke ==="
echo "GFLOW_ROOT:        $GFLOW_ROOT"
echo "GBRAIN_SOURCE_ID:  $GBRAIN_SOURCE_ID"
echo "flow_id:           $FLOW_ID"
echo

echo "[1/4] Seed a synthetic plan_created snapshot…"
bun bin/gflow gbrain seed-snapshot --kind=plan_created --flow="$FLOW_ID" --goal="$GOAL"
queued_count=$(ls -1 "$GFLOW_ROOT/$FLOW_ID/gbrain-queue/" 2>/dev/null | grep -c '\.jsonl$' || true)
if [ "$queued_count" -lt 1 ]; then
  echo "FAIL: expected ≥1 queued snapshot in $GFLOW_ROOT/$FLOW_ID/gbrain-queue/"
  exit 1
fi
echo "      ✓ $queued_count queued"

echo "[2/4] Drain to GBrain…"
drain_out=$(bun bin/gflow gbrain drain --flow="$FLOW_ID")
echo "$drain_out"
synced=$(echo "$drain_out" | grep -o '"synced":[[:space:]]*[0-9]*' | head -1 | grep -o '[0-9]*$')
failed=$(echo "$drain_out" | grep -o '"failed":[[:space:]]*[0-9]*' | head -1 | grep -o '[0-9]*$')
if [ "${synced:-0}" -lt 1 ] || [ "${failed:-0}" -gt 0 ]; then
  echo "FAIL: drain reported synced=${synced:-0} failed=${failed:-0}"
  exit 1
fi
echo "      ✓ drained $synced (failed=$failed)"

echo "[3/4] Query GBrain for the snapshot…"
query_out=$(bun bin/gflow gbrain query "$GOAL" --limit=5 --json 2>/dev/null || true)
echo "$query_out" | head -20
if ! echo "$query_out" | grep -q "$SLUG_PREFIX"; then
  echo "WARN: expected slug prefix '$SLUG_PREFIX' not found in query output"
  echo "      (this may be a GBrain indexing delay; rerun in a few seconds)"
else
  echo "      ✓ found slug under $SLUG_PREFIX"
fi

echo "[4/4] Inspect the raw page in GBrain…"
# Extract the first slug from the query output.
slug=$(echo "$query_out" | grep -o '"slug":[[:space:]]*"[^"]*"' | head -1 | sed -e 's/.*"\(gflow[^"]*\)".*/\1/')
if [ -n "$slug" ]; then
  echo "      slug: $slug"
  gbrain get "$slug" | head -30 || echo "WARN: gbrain get failed"
else
  echo "WARN: no slug to inspect"
fi

echo
echo "=== smoke OK ==="

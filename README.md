# G_Flow

> Open-source orchestration system for coding agents. Local-first. Pluggable backend.
> Built for the GStack × GBrain Hackathon, May 16, 2026.

G_Flow drives any coding agent — Claude Code, OpenCloud, the next one — through a long-running mission with adversarial validation, structured handoffs, and a corrective loop that knows when to stop and ask for help.

It is **not** a coding agent. It tells coding agents what to do, then verifies they actually did it.

---

## Quickstart

```bash
# 1. install deps
bun install

# 2. (optional) install the user-test backend
pip install browser-use            # or run with GFLOW_BACKEND=none

# 3. plan + run a flow
bun bin/gflow start "build a minimal todo app with login and a logout button"
bun bin/gflow resume               # Phase 2 — autonomous

# 4. watch it live (separate terminal)
bun run console:dev                # http://localhost:3030
```

The Worker writes code into `../demo-target/` by default — set `GFLOW_TARGET_DIR` to point it elsewhere.

The complete walkthrough is `scripts/demo-run.sh`.

---

## Architecture

```
PHASE 1 (planning — human in the loop)
   user goal ─┐
              ▼
          Planner (expand-tree, depth ≤ 3)         G1 self-check before write
              │   milestones → features → assertions
              ▼
        contract.yaml  ──►  user reviews, runs `gflow resume`
              │
              ▼
PHASE 2 (executing — fully autonomous)
   ┌────────────────────────────────────────────────┐
   │  for milestone in flow:                        │
   │    for feature in milestone:                   │
   │      Worker (Claude Code, clean ctx) → handoff │
   │      Screwdriver  (bun test / tsc)             │
   │      UserTest     (browser-use subprocess)  ◄── G2: exit≠0 → INFRA
   │      Steward.encode → decision.md              │
   │      while not all_pass:                       │
   │        Steward.triage:                         │
   │          INFRA            → halt (needs_human) │
   │          MISSING_ASSERTION→ append + revalidate│
   │          BROKEN_IMPL      → corrective Worker  │
   │                              (max 5 — G3 cap)  │
   │      advance feature                           │
   │    milestone close ──► async GBrain snapshot   │
   │  flow complete                                 │
   └────────────────────────────────────────────────┘
```

Three roles compose Phase 2: **Worker** writes code, **Screwdriver + UserTest** validate adversarially (they have not seen the implementation), and **Steward** encodes lessons + classifies failures. The orchestrator is a tiny pure function (`nextAction`) plus an I/O dispatch loop (`runFlow`).

### Critical gaps (always-on safeguards)

| Gate | Where | Behavior |
|---|---|---|
| **G1** depth cap + self-check | `src/runtime/planner.ts` | Hard depth = 3. Final pass rejects vague text, empty `evidence_required`, invalid validator, and same-feature contradictions. Phase 2 cannot start with a contract that fails self-check. |
| **G2** UserTest tool vs assertion | `src/runtime/validators/user-test.ts` | Subprocess exit 0 → parse JSON, mark pass/fail. Exit ≠ 0 / timeout / non-JSON → `tool_error`, hint = `INFRA`, **assertions are NOT marked failed**. Never triggers a corrective rewrite of working code. |
| **G3** corrective cap | `src/runtime/orchestrator.ts` | `state.corrective_attempts[feature_id] >= 5` → `state.phase = "needs_human"`, attempt history preserved, red banner in the Console. No silent infinite loops. |

---

## CLI

```
gflow start "<goal>"   Mint a flow, run Phase 1 (Planner), write contract.yaml.
gflow status           Print the latest flow's state.json.
gflow resume           Approve + run Phase 2 (orchestrator loop).
gflow approve          Alias for resume.
gflow help             Show usage.
```

Exit codes: `0` success, `1` Phase-2 halted to needs_human or Planner G1 failure, `64` bad usage.

---

## Environment

| Var | Default | Purpose |
|---|---|---|
| `GFLOW_ROOT` | `./.gflow` | Where flow artifacts live |
| `GFLOW_TARGET_DIR` | `../demo-target` | Worker sandbox (outside this repo) |
| `GFLOW_TARGET_URL` | `http://localhost:3000` | URL the UserTest validator opens |
| `GFLOW_BACKEND` | `claude-code` | `claude-code` / `opencloud` (stub) / `none` |
| `GFLOW_CLAUDE_BIN` | `claude` | Path to the `claude` CLI |
| `GFLOW_PYTHON` | `python3` | Python interpreter for `scripts/user_test_runner.py` |
| `GBRAIN_API_KEY` | unset | When set, V2 will POST snapshots to GBrain. V1 writes JSONL locally either way. |

---

## File layout

```
G_Flow/
├── bin/gflow                       executable shebang → src/cli
├── package.json                    bun + tsc + console:* scripts
├── scripts/
│   ├── demo-run.sh                 end-to-end demo (Phase 1 + Phase 2)
│   └── user_test_runner.py         browser-use subprocess (G2 contract)
├── src/
│   ├── adapters/                   AgentBackend interface
│   │   ├── backend.ts              { name, run(req) → result }
│   │   ├── claude-code.ts          shell-out to `claude -p`
│   │   ├── opencloud.ts            V1 stub (T1)
│   │   └── mock.ts                 deterministic test backend
│   ├── artifacts/                  Zod schemas
│   │   ├── contract.ts             Contract / Milestone / Feature / Assertion
│   │   ├── handoff.ts              Worker structured handoff
│   │   ├── reports.ts              ValidatorReport / Decision / TriageClassification
│   │   └── state.ts                FlowState
│   ├── cli/index.ts                start | status | resume | approve | help
│   ├── runtime/
│   │   ├── orchestrator.ts         pure nextAction(state) + Action union
│   │   ├── runner.ts               impure dispatch loop (G3 + MISSING_ASSERTION wiring)
│   │   ├── planner.ts              Phase 1 expand-tree + G1 self-check
│   │   ├── state.ts                state.json atomic IO
│   │   ├── contract-io.ts          contract.yaml read/write
│   │   ├── render-prompt.ts        {{var}} template renderer
│   │   ├── worker.ts               runWorker + parseHandoff + writeHandoff
│   │   ├── steward.ts              encode + triage runners + writers
│   │   └── validators/
│   │       ├── screwdriver.ts      runs `bun test` + `tsc --noEmit` in target_dir
│   │       └── user-test.ts        G2 subprocess wrapper
│   ├── prompts/                    version-controlled markdown templates
│   │   ├── planner-clarify.md
│   │   ├── planner-expand-tree.md
│   │   ├── worker.md
│   │   ├── steward-encode.md
│   │   └── steward-triage.md
│   ├── gbrain/client.ts            async snapshot queue (V2 will POST)
│   └── console/                    Next.js 15 App Router
│       ├── app/page.tsx            FlowStatus + FeatureList + ValidatorPanel
│       ├── app/api/stream/route.ts SSE endpoint (1s tick, mtime-gated)
│       └── lib/snapshot.ts         reads .gflow/<flow_id>/ → FlowSnapshot
└── tests/                          122+ tests; bun test runs them all
```

Runtime artifacts written under `.gflow/<flow_id>/`:

```
.gflow/<flow_id>/
├── goal.txt                                user's original prompt
├── contract.yaml                           validation contract (post-G1)
├── state.json                              FlowState (atomic writes)
├── features/                               (Phase 1 expansion working set)
├── handoffs/F-001__attempt-01.json         Worker handoff per attempt
├── reports/F-001__screwdriver__attempt-01.json
├── reports/F-001__usertest__attempt-01.json
├── reports/F-001__triage__attempt-02.json  Steward classification
├── decisions/F-001__attempt-01.md          Steward.encode (frontmatter + body)
└── gbrain-queue/2026-05-16T..._feature_close.jsonl
```

Attempt numbering is **linear per feature**: original = 01, first corrective = 02, etc. Validator and triage reports use the same attempt counter as the worker run they followed.

---

## Demo walkthrough

```bash
# happy path with the canned goal in scripts/demo-run.sh
./scripts/demo-run.sh

# or with a custom goal
./scripts/demo-run.sh "build a kanban board with three columns and drag-and-drop"
```

In a second terminal:

```bash
bun run console:dev
# → http://localhost:3030
```

The Console hydrates from the latest flow on first paint, then subscribes to `/api/stream` for live SSE updates (1s tick, only re-emits when an artifact mtime changes).

### Demo "seeded bug" (per `G_FLOW_DESIGN.md` §10)

The Worker prompt for the todo demo intentionally omits `router.refresh()` after a mutation. The UserTest assertion *"after submitting 'Buy milk', 'Buy milk' appears in the list"* fails. Steward classifies `BROKEN_IMPL`, a corrective Worker patches it, validators flip green, banner clears.

---

## Testing

```bash
bun test                  # 129 passing tests across 12 files
bun x tsc --noEmit        # type check
bun run console:dev       # smoke-check the UI
```

The orchestrator's decision logic (`nextAction`) is pure — tests drive it through 17 canned states covering happy path, G2, G3, MISSING_ASSERTION, and triage routing. Integration tests in `tests/runner.test.ts` drive the full corrective loop with mocked component runners.

---

## What's **not** in V1 (tracked in [TODOS.md](./TODOS.md))

- Real OpenCloud backend — V1 ships an honest stub
- ZeroEntropy retrieval upgrade (`zembed-1`, `zerank-2`)
- Auto-generated per-assertion test cases
- Multi-day stability + crash recovery harness
- Advanced GBrain graph queries in the Steward hot path
- Console "intervene / pause" button
- Lightsprint deployment as a required gate (it's a best-effort target)

Phase 2 in V1 is fully autonomous; the operator gets `needs_human` halts (G3, INFRA) instead of a pause button.

---

## License & references

- [Factory.ai Missions architecture](https://factory.ai/news/missions-architecture) — the design G_Flow generalizes
- [browser-use](https://github.com/browser-use/browser-use) — UserTest validator backend
- [open-computer-use](https://github.com/coasty-ai/open-computer-use) — desktop-UI fallback (deferred)
- [GBrain](https://github.com/garrysburgers/gbrain) — long-term memory layer (V2 retrieval integration is T5)

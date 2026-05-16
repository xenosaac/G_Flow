# G_Flow

> Open-source orchestration system for coding agents. Local-first. Pluggable backend.
> Built for the GStack × GBrain Hackathon, May 16, 2026.

G_Flow drives any coding agent — Claude Code, Codex, OpenCloud, the next one — through a long-running mission with adversarial validation, structured handoffs, and a corrective loop that knows when to stop and ask for help.

It is **not** a coding agent. It tells coding agents what to do, then verifies they actually did it.

---

## Quickstart

### Option A: drive everything from the browser (Agent Workbench)

```bash
bun install
bun run console:dev                # open http://localhost:3030
```

In the Console:

1. Pick a backend from the dropdown (Claude Code or Codex CLI — auto-detected).
2. Type a goal in the textarea, click **Start Flow**.
3. Read the generated `contract.yaml` (path shown in the status line) — or just click **Approve / Resume** to run Phase 2 autonomously.
4. Live state (FlowStatus, FeatureList, ValidatorPanel, red needs_human banner) updates over SSE.
5. Use the chat textarea to ask the agent ad-hoc questions; every conversation is persisted to `.gflow/chat/<session>.json`.

### Option B: CLI

```bash
bun bin/gflow start "build a minimal todo app with login and a logout button"
bun bin/gflow resume               # Phase 2 — autonomous
bun bin/gflow status               # snapshot of the latest flow
```

### Backends

Set `GFLOW_BACKEND` to pick which CLI drives the agents:

| value | what it runs |
|---|---|
| `claude-code` (default) | `claude -p` reads stdin → emits the response |
| `codex` | `codex exec --skip-git-repo-check -C <cwd> --sandbox workspace-write -o <tmp> -` |
| `opencloud` | V1 stub (throws — TODOS T1) |
| `none` / `off` | no agent calls; useful for inspecting state |

Unknown values **error explicitly** ("Unknown GFLOW_BACKEND=…") instead of silently falling back.

The Worker writes code into `../demo-target/` by default — set `GFLOW_TARGET_DIR` to point it elsewhere.

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
| **G2** UserTest tool vs assertion | `src/runtime/validators/user-test.ts` | Subprocess exit 0 → parse JSON, mark pass/fail. Exit ≠ 0 / timeout / non-JSON → `tool_error`, hint = `INFRA`, **assertions are NOT marked failed**. Per-assertion `outcome: "tool_error"` ALSO escalates the whole report (a captcha or browser-use crash never gets mistaken for an application bug). Python wrapper exits 4 when browser-use is installed but no LLM API key is set. |
| **G3** corrective cap | `src/runtime/orchestrator.ts` | `state.corrective_attempts[feature_id] >= 5` → `state.phase = "needs_human"`, attempt history preserved, red banner in the Console. No silent infinite loops. |

### Screwdriver — per-assertion checks

For every `screwdriver` assertion, the Planner emits a `check` field that tells the validator exactly how to verify it deterministically. Three shapes:

```yaml
check: { kind: file_exists, path: index.html }
check: { kind: file_contains, path: src/app.ts, substring: "router.refresh()" }
check: { kind: command, cmd: [curl, -fsS, http://localhost:3000/health] }
```

Path inputs are resolved INSIDE `target_dir`; absolute paths and `..` escapes are rejected. Commands run as argv (no shell), with a 60-second default timeout.

Static HTML projects (no `bun test`, no `tsconfig.json`) no longer blanket-fail. Screwdriver detects the absence of test scaffolding and skips inapplicable project-wide checks; an assertion without an explicit `check` passes on benefit of doubt with a detail noting the gap.

---

## CLI

```
gflow start "<goal>"   Mint a flow, run Phase 1 (Planner), write contract.yaml.
gflow status           Print the latest flow's state.json.
gflow resume           Approve + run Phase 2 (orchestrator loop).
gflow approve          Alias for resume.
gflow help             Show usage.
```

Exit codes: `0` success, `1` Phase-2 halted to needs_human or Planner G1 failure, `64` bad usage / unknown backend.

## Web API (Console)

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/api/backends` | — | `{ backends: [{ name, available, note? }] }` |
| POST | `/api/chat` | `{ session_id?, backend?, message }` | `{ ok, session_id, reply, exit_code, transcript_path }` |
| POST | `/api/flows/start` | `{ goal, backend? }` | `{ ok, flow_id, contract_path, milestones, features, assertions }` |
| POST | `/api/flows/resume` | `{ flow_id?, backend?, target_dir?, target_url? }` | `{ ok, flow_id, status, iterations, reason? }` |
| GET | `/api/stream` | — | SSE: `data: {type, ...}\n\n` ticking every 1s |

Chat transcripts are persisted to `.gflow/chat/<session_id>.json` (atomic writes). The chat surface is a shell-like one-shot wrapper over `AgentBackend.run({role: "chat", …})` — no prior history is fed back into the prompt; the transcript is for the human, not the agent.

---

## Environment

| Var | Default | Purpose |
|---|---|---|
| `GFLOW_ROOT` | `./.gflow` | Where flow artifacts live |
| `GFLOW_TARGET_DIR` | `../demo-target` | Worker sandbox (outside this repo) |
| `GFLOW_TARGET_URL` | `http://localhost:3000` | URL the UserTest validator opens |
| `GFLOW_BACKEND` | `claude-code` | `claude-code` / `codex` / `opencloud` (stub) / `none`. Unknown values error explicitly. |
| `GFLOW_CLAUDE_BIN` | `claude` | Path to the `claude` CLI |
| `GFLOW_CODEX_BIN` | `codex` | Path to the `codex` CLI |
| `GFLOW_PYTHON` | `python3` | Python interpreter for `scripts/user_test_runner.py` |
| `G_FLOW_USERTEST_FAKE` | unset | `pass` / `fail` → Python wrapper returns canned results without browser-use (useful for demos and CI). |
| `BROWSER_USE_API_KEY` / `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `GOOGLE_API_KEY` | unset | At least one needed when browser-use is installed; absent → exit 4 → tool_error / INFRA (G2). |
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

## Demo walkthroughs

### Synthetic in-process E2E (no LLM, runs in `bun test`)

`tests/e2e-static.test.ts` drives `runFlow` end-to-end against a real isolated `target_dir`. A fake Worker writes `tests/fixtures/static-todo.html` to disk; the **real** Screwdriver runs `file_exists` + `file_contains` checks; happy-dom verifies the click behavior in-process. Proves the entire pipeline without any LLM cost.

### Real isolated E2E with Codex or Claude

```bash
# default: codex
bash scripts/e2e-real.sh

# or claude
GFLOW_BACKEND=claude-code bash scripts/e2e-real.sh

# with a custom goal
bash scripts/e2e-real.sh "build a kanban board with three columns"
```

The script mktemp's `GFLOW_ROOT` and `GFLOW_TARGET_DIR`, git-inits the target, runs Phase 1 (Planner) then Phase 2 (Worker + validators + Steward), and finally invokes `scripts/click-verify.ts` to prove the generated `index.html` actually responds to the Buy milk click. Artifact dirs are preserved on exit so you can inspect contracts, handoffs, reports, and decisions.

### Browser-click verifier (standalone)

```bash
bun scripts/click-verify.ts <path-to-index.html> "Buy milk"
```

Exits 0 if `<input id="todo-input">` → typing → `<button id="add-todo">` click results in "Buy milk" appearing inside `<ul id="todo-list">`. Used by the synthetic test and `scripts/e2e-real.sh`.

### Light demo (Phase 1 only)

```bash
./scripts/demo-run.sh
./scripts/demo-run.sh "build a kanban board with three columns and drag-and-drop"
```

In a second terminal:

```bash
bun run console:dev
# → http://localhost:3030
```

The Console hydrates from the latest flow on first paint, then subscribes to `/api/stream` for live SSE updates (1s tick, only re-emits when an artifact mtime changes).

---

## Testing

```bash
bun test                  # 184 passing tests across 19 files
bun x tsc --noEmit        # type check
bun run console:build     # production build of the Console
bun run console:dev       # smoke-check the UI (auto-reload on edits)
```

The orchestrator's decision logic (`nextAction`) is pure — tests drive it through 17 canned states covering happy path, G2, G3, MISSING_ASSERTION, and triage routing. Integration tests in `tests/runner.test.ts` drive the full corrective loop with mocked component runners. `tests/e2e-static.test.ts` runs the synthetic end-to-end flow plus a happy-dom click harness. `tests/real-codex-contract.test.ts` parses an actual `codex exec` Planner output against the Zod schema and the G1 self-check as a regression guard.

---

## What's **not** in V1 (tracked in [TODOS.md](./TODOS.md))

- Real OpenCloud backend — V1 ships an honest stub
- ZeroEntropy retrieval upgrade (`zembed-1`, `zerank-2`)
- Auto-generated per-assertion test cases (Planner emits explicit `check` fields; auto-generating commands from prose is V2)
- Multi-day stability + crash recovery harness
- Advanced GBrain graph queries in the Steward hot path
- Console "intervene / pause" button (the existing red `needs_human` banner is the V1 UX)
- Lightsprint deployment as a required gate (it's a best-effort target)
- Re-feeding chat history into prompts (V1 is shell-like one-shot)
- Browser-driven UserTest in CI (`G_FLOW_USERTEST_FAKE=pass` covers it; real browser-use needs a configured LLM provider key)

Phase 2 in V1 is fully autonomous; the operator gets `needs_human` halts (G3, INFRA) instead of a pause button.

---

## License & references

- [Factory.ai Missions architecture](https://factory.ai/news/missions-architecture) — the design G_Flow generalizes
- [browser-use](https://github.com/browser-use/browser-use) — UserTest validator backend
- [open-computer-use](https://github.com/coasty-ai/open-computer-use) — desktop-UI fallback (deferred)
- [GBrain](https://github.com/garrysburgers/gbrain) — long-term memory layer (V2 retrieval integration is T5)

# G_Flow

> Open-source orchestration system for coding agents. Local-first. Pluggable backend.
> Built for the GStack × GBrain Hackathon, May 16, 2026.

G_Flow drives coding agents such as Claude Code and Codex through a long-running mission with adversarial validation, structured handoffs, and a corrective loop that knows when to stop and ask for help.

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
3. If the goal is vague, answer the clarification questions in chat. The Console does not write `contract.yaml` until the planning gate is ready.
4. Read the generated `contract.yaml`, then click **Accept Plan** to run Phase 2.
5. Live state (FlowStatus, FeatureList, ValidatorPanel, pause/needs_human state) updates over SSE.
6. Use the chat textarea to ask contextual questions; every conversation is persisted to `.gflow/chat/<session>.json`, while prompts stay bounded.

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
| `none` / `off` | no agent calls; useful for inspecting state |

Unknown values **error explicitly** ("Unknown GFLOW_BACKEND=…") instead of silently falling back.

The Worker writes code into `../demo-target/` by default — set `GFLOW_TARGET_DIR` to point it elsewhere.

---

## Architecture

```
PHASE 1 (clarifying + planning — human in the loop)
   user goal ─┐
              ▼
          GStack intake gate                       asks questions if vague
              │
              ▼
          Planner (expand-tree, depth ≤ 3)         G1 + GStack review before write
              │   milestones → features → assertions
              ▼
        contract.yaml  ──►  user reviews, runs `gflow resume`
              │
              ▼
PHASE 2 (executing — fully autonomous)
   ┌────────────────────────────────────────────────┐
   │  for milestone in flow:                        │
   │    for feature in milestone:                   │
   │      Worker (isolated git worktree) → handoff  │
   │      Screwdriver  (bun test / tsc)             │
   │      UserTest     (Playwright Chromium)     ◄── G2: exit≠0 → INFRA
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
| **G2** UserTest tool vs assertion | `src/runtime/validators/user-test.ts` | Playwright subprocess exit 0 → parse JSON, mark pass/fail. Exit ≠ 0 / timeout / non-JSON → `tool_error`, hint = `INFRA`, **assertions are NOT marked failed**. Per-assertion `outcome: "tool_error"` also escalates the whole report. Missing Playwright/Chromium is infrastructure, not an app failure. |
| **G3** corrective cap | `src/runtime/orchestrator.ts` | `state.corrective_attempts[feature_id] >= 5` → `state.phase = "needs_human"`, attempt history preserved, red banner in the Console. No silent infinite loops. |

### Screwdriver — per-assertion checks

For every `screwdriver` assertion, the Planner emits a `check` field that tells the validator exactly how to verify it deterministically. Three shapes:

```yaml
check: { kind: file_exists, path: index.html }
check: { kind: file_contains, path: src/app.ts, substring: "router.refresh()" }
check: { kind: command, cmd: [curl, -fsS, http://localhost:3000/health], stdout_includes: ok }
```

Path inputs are resolved INSIDE `target_dir`; absolute paths and `..` escapes are rejected. Commands run as argv (no shell), with a 60-second default timeout.

Static HTML projects (no `bun test`, no `tsconfig.json`) no longer blanket-fail. Screwdriver detects the absence of test scaffolding and skips inapplicable project-wide checks; an assertion without an explicit `check` passes on benefit of doubt with a detail noting the gap.

### UserTest — Playwright browser flows

Every `user-test` assertion includes a deterministic `user_check`:

```yaml
user_check:
  kind: browser_flow
  start: file
  path: index.html
  steps:
    - { kind: fill, selector: "#todo-input", value: "Buy milk" }
    - { kind: click, selector: "#add-todo" }
    - { kind: expect_text, selector: "#todo-list", text: "Buy milk" }
```

File paths are relative to `target_dir` and cannot escape it. `goto.path` is relative to `GFLOW_TARGET_URL`; external navigation is rejected.

---

## CLI

```
gflow start "<goal>"   Mint a flow, run Phase 1 (Planner), write contract.yaml.
gflow status           Print the latest flow's state.json.
gflow pause            Request pause at the next checkpoint.
gflow resume           Approve + run Phase 2 (orchestrator loop).
gflow approve          Alias for resume.
gflow help             Show usage.
```

Exit codes: `0` success, `1` Phase-2 halted to needs_human or Planner G1 failure, `64` bad usage / unknown backend.

## Web API (Console)

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/api/backends` | — | `{ backends: [{ name, available, note? }] }` |
| POST | `/api/chat` | `{ session_id?, flow_id?, backend?, message }` | `{ ok, session_id, reply, exit_code, transcript_path }` |
| POST | `/api/flows/start` | `{ goal, backend? }` | ready: `{ ok, status:"ready", flow_id, contract_path, milestones, features, assertions }`; clarifying: `{ ok, status:"needs_clarification", flow_id, questions }` |
| POST | `/api/flows/clarify` | `{ flow_id, answers, backend? }` | same ready/clarifying shape as start |
| POST | `/api/flows/pause` | `{ flow_id?, reason? }` | `{ ok, flow_id, status }` |
| POST | `/api/flows/resume` | `{ flow_id?, backend?, target_dir?, target_url? }` | `{ ok, flow_id, status, iterations, reason? }` |
| GET | `/api/stream` | — | SSE: `data: {type, ...}\n\n` ticking every 1s |

Chat transcripts are persisted to `.gflow/chat/<session_id>.json` (atomic writes). Backend prompts include the latest flow snapshot, retrieved local memory summary, the recent 8 messages, and the latest user message. Full transcripts are not sent indefinitely.

---

## Environment

| Var | Default | Purpose |
|---|---|---|
| `GFLOW_ROOT` | `./.gflow` | Where flow artifacts live |
| `GFLOW_TARGET_DIR` | `../demo-target` | Worker sandbox (outside this repo) |
| `GFLOW_TARGET_URL` | `http://localhost:3000` | URL the UserTest validator opens |
| `GFLOW_BACKEND` | `claude-code` | `claude-code` / `codex` / `none`. Unknown values error explicitly. |
| `GFLOW_GSTACK_DIR` | unset | Optional local GStack skill-pack directory; reads `office-hours/SKILL.md` and `plan-eng-review/SKILL.md` for planning review prompts. |
| `GFLOW_CLAUDE_BIN` | `claude` | Path to the `claude` CLI |
| `GFLOW_CODEX_BIN` | `codex` | Path to the `codex` CLI |
| `GBRAIN_MODE` | `off` | `off` / `local-cli` / `mcp-http`. See [GBrain integration](#gbrain-integration). Unknown values resolve to a `ConfigErrorAdapter` (runtime keeps working; explicit drain/health surface the error). |
| `GBRAIN_BIN` | `gbrain` | Path to the `gbrain` CLI binary (used by `GBRAIN_MODE=local-cli`). |
| `GBRAIN_HTTP_URL` | unset | Base URL of a running `gbrain serve --http`, e.g. `http://127.0.0.1:3131` (used by `GBRAIN_MODE=mcp-http`). |
| `GBRAIN_AUTH_TOKEN` | unset | Bearer token for the GBrain MCP HTTP server. Create one with `gbrain auth create gflow`. |
| `GBRAIN_SOURCE_ID` | `gflow` | Source-scope tag. Local-CLI passes it via `GBRAIN_SOURCE` env (6-tier resolution); MCP-HTTP includes it in `query` args (no `put_page` field exists upstream — writes land under the auth token's default scope). |
| `GFLOW_GBRAIN_RETRIEVAL` | unset | Set to `off` to disable retrieval injection into Planner/Worker/Steward prompts. Otherwise retrieval is on whenever `GBRAIN_MODE !== "off"`. |
| `GBRAIN_API_KEY` | unset | **Deprecated** — previously used by the V1 placeholder. Set `GBRAIN_MODE=mcp-http` + `GBRAIN_AUTH_TOKEN` instead. |

---

## GBrain integration

G_Flow can stream durable, structured "memory pages" to [GBrain](https://github.com/garrytan/gbrain) — Garry Tan's open-source brain-database — at every meaningful flow event (`plan_created`, `feature_close`, `worker_handoff`, `validator_report`, `steward_decision`, `steward_triage`, `milestone_close`, `flow_complete`). It can also retrieve top-K relevant past pages and splice them into the Planner / Worker / Steward prompts, with layered prompt-injection isolation.

The runtime contract is unchanged: every snapshot lands in a **durable local JSONL outbox** at `.gflow/<flow_id>/gbrain-queue/` synchronously. The remote bridge (CLI or HTTP) drains the outbox in the background. If GBrain is missing, offline, or misconfigured, **flows keep running**.

### Three modes (set via `GBRAIN_MODE`)

| mode | how it talks to GBrain | health probe | best for |
|---|---|---|---|
| `off` *(default)* | JSONL outbox only — no upstream sync | always ok | when GBrain isn't installed yet |
| `local-cli` | `gbrain call put_page '<json>'` / `gbrain call query '<json>'` via spawn | `gbrain --version` + `gbrain doctor --json --fast` | single-machine setups; reuses `GBRAIN_SOURCE` 6-tier resolution |
| `mcp-http` | `POST <url>/mcp` JSON-RPC `tools/call` with bearer auth | `GET /health` + authenticated `tools/list` | remote / shared GBrain server |

Unknown `GBRAIN_MODE` resolves to a `ConfigErrorAdapter`: runtime stays alive, but explicit user actions (drain button in Console, `gflow gbrain drain` CLI) return `{ok: false, errors: [{message: "GBrain misconfigured: …"}]}`.

### Install GBrain locally

Upstream explicitly forbids `npm install -g gbrain` (postinstall hooks would be skipped). Use:

```bash
git clone https://github.com/garrytan/gbrain.git ~/gbrain
cd ~/gbrain && bun install && bun link
gbrain init                # PGLite by default, no server needed
gbrain doctor --json --fast
```

Then, for `mcp-http` mode:

```bash
gbrain auth create gflow                       # prints a bearer token to stderr
gbrain serve --http --port 3131                # in another terminal
```

In a third terminal, point G_Flow at it:

```bash
export GBRAIN_MODE=mcp-http
export GBRAIN_HTTP_URL=http://127.0.0.1:3131
export GBRAIN_AUTH_TOKEN=<paste the token from `gbrain auth create`>
bun bin/gflow gbrain health    # should print ok=true
```

### CLI surface

```
gflow gbrain health [--json]                    Show adapter mode + connectivity
gflow gbrain drain [--flow=<id>]                Push queued snapshots into GBrain
gflow gbrain query "<q>" [--limit=N] [--json]   Retrieve top-K pages
gflow gbrain seed-snapshot --kind=plan_created --flow=<id> [--goal=<g>]   (admin/smoke-test only)
```

Exit codes: `0` on success, `1` on operation failure (e.g. some drains failed), `64` when the adapter itself is misconfigured.

### Web surface

- `GET /api/gbrain[?flow_id=<id>]` → `{mode, source_id, health, queue:{queued,synced,failed}, last_drain, last_error, entries[], counts}`
- `POST /api/gbrain/drain` body `{flow_id?}` → `DrainResult`; returns `503` when `mode === "off"`.

The Console GBrain panel shows: mode badge, health pill, `[Drain now]` button (disabled when off), per-state pill chips (queued / synced / failed), last-10 timeline with sync-state coloured pip, and any active warnings (e.g. `source_unscoped_writes` under HTTP).

### Page format on disk

Each snapshot is rendered as a GBrain-conformant markdown page:

```markdown
---
type: note
title: G_Flow · feature_close · F-001 · 2026-05-16T12:34:56Z
tags: [gflow, f-2026-05-16-1234, feature-close, f-001, m-001]
gflow:
  schema_version: 2
  kind: feature_close
  flow_id: f_2026_05_16_1234         # ← original ids preserved verbatim
  feature_id: F-001
  milestone_id: M-001
  contract_hash: deadbeefcafef00d
  recorded_at: 2026-05-16T12:34:56Z
  source_id: gflow
  gflow_version: 0.1.0
  ...
---

## Summary

Feature F-001 ('Add a Todo button') closed under milestone M-001.
Screwdriver: pass (3/3). User test: pass (2/2). Handoff: 4 files, 6 commands.

## Payload

```json
{ ...full GbrainSnapshotV2.payload... }
```
```

Slugs are kebab-case (`gflow/<source>/<flow>/<kind>-<subject>-<ts>`); original ids live in the `gflow:` frontmatter namespace.

### Retrieval injection

Before each Planner / Worker / Steward LLM call, G_Flow runs `adapter.queryContext(query, {limit:5})` and splices results into `{{gbrain_context}}` in the prompt template. Content is wrapped in `<gbrain-memory slug="…" score="…">` tags + blockquote prefix; the prompt template explicitly tells the LLM to treat anything inside the tags as data, not instructions. Adversarial line-start role markers (`### system`, `<|im_start|>`) are stripped; control chars stripped; `{{...}}` braces escaped; per-line capped at 200 chars; total block capped at 4 KB; results with >10% role-marker density are entirely suppressed.

To disable retrieval entirely (even when `GBRAIN_MODE !== "off"`): `GFLOW_GBRAIN_RETRIEVAL=off`.

### Smoke test

```bash
bash scripts/gbrain-smoke.sh
```

Gates on `which gbrain`; if absent, exits 0 with a skip message. Otherwise: seeds a synthetic `plan_created` snapshot via `gflow gbrain seed-snapshot`, drains it, queries it back, and inspects the rendered page with `gbrain get <slug>`.

---

## File layout

```
G_Flow/
├── bin/gflow                       executable shebang → src/cli
├── package.json                    bun + tsc + console:* scripts
├── scripts/
│   ├── demo-run.sh                 end-to-end demo (Phase 1 + Phase 2)
│   └── e2e-real.sh                 isolated real backend + Playwright check
├── src/
│   ├── adapters/                   AgentBackend interface
│   │   ├── backend.ts              { name, run(req) → result }
│   │   ├── claude-code.ts          shell-out to `claude -p`
│   │   └── mock.ts                 deterministic test backend
│   ├── artifacts/                  Zod schemas
│   │   ├── contract.ts             Contract / Milestone / Feature / Assertion
│   │   ├── handoff.ts              Worker structured handoff
│   │   ├── reports.ts              ValidatorReport / Decision / TriageClassification
│   │   └── state.ts                FlowState
│   ├── cli/index.ts                start | status | pause | resume | approve | help
│   ├── runtime/
│   │   ├── orchestrator.ts         pure nextAction(state) + Action union
│   │   ├── runner.ts               impure dispatch loop (G3 + MISSING_ASSERTION wiring)
│   │   ├── control.ts              pause control + run.lock recovery
│   │   ├── worktree.ts             per-feature git worktree isolation
│   │   ├── memory.ts               MemoryProvider + local summary fallback
│   │   ├── planning-review.ts      GStack intake + engineering review provider
│   │   ├── planner.ts              Phase 1 expand-tree + G1 self-check
│   │   ├── state.ts                state.json atomic IO
│   │   ├── contract-io.ts          contract.yaml read/write
│   │   ├── render-prompt.ts        {{var}} template renderer
│   │   ├── worker.ts               runWorker + parseHandoff + writeHandoff
│   │   ├── steward.ts              encode + triage runners + writers
│   │   └── validators/
│   │       ├── screwdriver.ts      runs `bun test` + `tsc --noEmit` in target_dir
│   │       ├── user-test.ts        G2 subprocess wrapper
│   │       └── playwright-user-test.ts deterministic Chromium runner
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
├── clarifications/intake-01.json           GStack intake questions / ready brief
├── control.json                            pause requests
├── run.lock                                live runner heartbeat
├── contract.yaml                           validation contract (post-review)
├── state.json                              FlowState (atomic writes)
├── worktrees/F-001__attempt-01/            isolated Worker attempt
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

`tests/e2e-static.test.ts` drives `runFlow` end-to-end against a real isolated `target_dir`. A fake Worker writes `tests/fixtures/static-todo.html` to disk; the **real** Screwdriver runs `file_exists` + `file_contains` checks; happy-dom verifies the click behavior in-process. `tests/user-test.test.ts` also runs real Playwright Chromium against a generated static todo page. Proves the pipeline without any LLM cost.

### Real isolated E2E with Codex or Claude

```bash
# default: codex
bash scripts/e2e-real.sh

# or claude
GFLOW_BACKEND=claude-code bash scripts/e2e-real.sh

# with a custom goal
bash scripts/e2e-real.sh "build a kanban board with three columns"
```

The script mktemp's `GFLOW_ROOT` and `GFLOW_TARGET_DIR`, git-inits the target, runs Phase 1 (Planner) then Phase 2 (Worker + validators + Steward), and finally invokes the Playwright runner to prove the generated `index.html` actually responds to the Buy milk click in Chromium. Artifact dirs are preserved on exit so you can inspect contracts, handoffs, reports, and decisions.

### Browser verifier (standalone)

```bash
cd <target-dir>
cat spec.json | bun /path/to/G_Flow/src/runtime/validators/playwright-user-test.ts
```

The spec is the same `target_url` + `assertions[].user_check` JSON used by the runtime.

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
bun test                  # 233 passing tests across 23 files
bun x tsc --noEmit        # type check
bun run console:build     # production build of the Console
bun run console:dev       # smoke-check the UI (auto-reload on edits)
```

The orchestrator's decision logic (`nextAction`) is pure — tests drive it through canned states covering happy path, G2, G3, MISSING_ASSERTION, and triage routing. Integration tests in `tests/runner.test.ts` drive the full corrective loop, pause/resume, stale lock recovery, and git worktree merge behavior. `tests/e2e-static.test.ts` runs the synthetic end-to-end flow plus a happy-dom click harness. `tests/user-test.test.ts` exercises real Playwright browser validation.

---

## What's **not** in V1 (tracked in [TODOS.md](./TODOS.md))

- ZeroEntropy retrieval upgrade (`zembed-1`, `zerank-2`)
- Auto-generated per-assertion test cases (Planner emits explicit `check` fields; auto-generating commands from prose is V2)
- GBrain graph queries / cross-flow correlation in the Steward hot path (V2 ships `query` and `put_page` only; `traverse_graph`, `add_link`, `add_timeline_entry` exist upstream but aren't wired in yet)
- MCP-stdio adapter (HTTP mode covers remote use; stdio would require a long-lived child process that conflicts with the non-blocking contract)
- Multi-day stability and process supervision hardening beyond stale lock recovery
- Lightsprint deployment as a required gate (it's a best-effort target)

Phase 2 is autonomous by default, but the operator can pause at checkpoints and resume without losing feature/attempt state.

---

## License & references

- [Factory.ai Missions architecture](https://factory.ai/news/missions-architecture) — the design G_Flow generalizes
- [open-computer-use](https://github.com/coasty-ai/open-computer-use) — desktop-UI fallback (deferred)
- [GBrain](https://github.com/garrytan/gbrain) — long-term memory layer wired in via `GBRAIN_MODE={local-cli,mcp-http}` (see [GBrain integration](#gbrain-integration))

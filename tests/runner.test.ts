import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, rm, writeFile, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import YAML from "yaml";
import {
  runFlow,
  appendAssertions,
} from "../src/runtime/runner.ts";
import { writeState } from "../src/runtime/state.ts";
import { writeContractYaml, readContractYaml } from "../src/runtime/contract-io.ts";
import { Handoff } from "../src/artifacts/handoff.ts";
import {
  ValidatorReport,
  type ValidatorReportT,
} from "../src/artifacts/reports.ts";
import {
  Contract,
  type ContractT,
  type AssertionT,
} from "../src/artifacts/contract.ts";
import type { FlowStateT } from "../src/artifacts/state.ts";
import { MockBackend } from "../src/adapters/mock.ts";
import { CORRECTIVE_CAP } from "../src/runtime/orchestrator.ts";
import type { runWorker } from "../src/runtime/worker.ts";
import type { runScrewdriver } from "../src/runtime/validators/screwdriver.ts";
import type { runUserTest } from "../src/runtime/validators/user-test.ts";
import type { runStewardEncode, runStewardTriage } from "../src/runtime/steward.ts";
import { writeControl, lockPath, RunLockError } from "../src/runtime/control.ts";
import { featureWorktreePath } from "../src/runtime/worktree.ts";
import { spawnPiped } from "../src/adapters/spawn.ts";

let TMP: string;
const FLOW = "f_test_int_0001";

beforeEach(async () => {
  TMP = join(
    tmpdir(),
    `gflow-runner-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  await mkdir(TMP, { recursive: true });
});

afterEach(async () => {
  await rm(TMP, { recursive: true, force: true });
});

function buildContract(): ContractT {
  return Contract.parse({
    flow_id: FLOW,
    goal: "build a todo app with login",
    created_at: "2026-05-16T10:00:00.000Z",
    milestones: [
      {
        id: "M-001",
        title: "Auth",
        endpoint_criteria: "auth end-to-end",
        features: [
          {
            id: "F-001",
            title: "Signup",
            spec: "POST /api/auth/signup",
            assertions: [
              {
                id: "A-001-001",
                text: "POST /signup returns 201",
                validator: "screwdriver",
                evidence_required: "HTTP capture",
                check: {
                  kind: "command",
                  cmd: ["true"],
                  expected_exit_code: 0,
                },
              },
              {
                id: "A-001-002",
                text: "/signup form redirects to /dashboard",
                validator: "user-test",
                evidence_required: "screenshot",
                user_check: {
                  kind: "browser_flow",
                  start: "target_url",
                  steps: [{ kind: "expect_url", contains: "localhost" }],
                },
              },
            ],
          },
        ],
      },
    ],
  });
}

async function seedFlow(contract: ContractT): Promise<{
  dir: string;
  handoffsDir: string;
  reportsDir: string;
  decisionsDir: string;
}> {
  const dir = join(TMP, FLOW);
  const handoffsDir = join(dir, "handoffs");
  const reportsDir = join(dir, "reports");
  const decisionsDir = join(dir, "decisions");
  await mkdir(join(dir, "features"), { recursive: true });
  await mkdir(handoffsDir, { recursive: true });
  await mkdir(reportsDir, { recursive: true });
  await mkdir(decisionsDir, { recursive: true });
  await writeContractYaml(contract, join(dir, "contract.yaml"));
  await writeState(initialState(), TMP);
  return { dir, handoffsDir, reportsDir, decisionsDir };
}

function initialState(): FlowStateT {
  return {
    flow_id: FLOW,
    phase: "executing",
    current_milestone: null,
    current_feature: null,
    current_step: null,
    corrective_attempts: {},
    counters: { llm_calls: 0, tokens_in: 0, tokens_out: 0, usd_spent: 0 },
    started_at: "2026-05-16T10:00:00.000Z",
    updated_at: "2026-05-16T10:00:00.000Z",
  };
}

const okHandoff = (
  feature_id: string,
  ids: string[],
): ReturnType<typeof Handoff.parse> =>
  Handoff.parse({
    flow_id: FLOW,
    feature_id,
    completed: true,
    files_touched: [],
    commands_run: [],
    assertions_attempted: ids,
    deviations: "",
    next_worker_hints: "",
    recorded_at: "2026-05-16T11:00:00.000Z",
  });

function passReport(
  feature_id: string,
  ids: string[],
  validator: "screwdriver" | "user-test",
): ValidatorReportT {
  return ValidatorReport.parse({
    feature_id,
    flow_id: FLOW,
    validator,
    status: "pass",
    assertion_results: ids.map((id) => ({
      assertion_id: id,
      outcome: "pass",
      detail: "",
    })),
    raw_stdout_tail: "",
    raw_stderr_tail: "",
    recorded_at: "2026-05-16T11:30:00.000Z",
    steward_hint: "NONE",
  });
}

function failReport(
  feature_id: string,
  ids: string[],
  validator: "screwdriver" | "user-test",
): ValidatorReportT {
  return ValidatorReport.parse({
    feature_id,
    flow_id: FLOW,
    validator,
    status: "fail",
    assertion_results: ids.map((id) => ({
      assertion_id: id,
      outcome: "fail",
      detail: "expected redirect, got 200",
    })),
    raw_stdout_tail: "",
    raw_stderr_tail: "",
    recorded_at: "2026-05-16T11:35:00.000Z",
    steward_hint: "NONE",
  });
}

function toolErrorReport(feature_id: string): ValidatorReportT {
  return ValidatorReport.parse({
    feature_id,
    flow_id: FLOW,
    validator: "user-test",
    status: "tool_error",
    assertion_results: [],
    raw_stdout_tail: "",
    raw_stderr_tail: "browser runner crashed",
    recorded_at: "2026-05-16T11:40:00.000Z",
    steward_hint: "INFRA",
  });
}

const okEncode: typeof runStewardEncode = async () => ({
  body: `---\nfeature_id: x\nflow_id: ${FLOW}\noutcome: passing\nrecorded_at: 2026-05-16T12:00:00Z\nbacklinks: []\nattempt: 1\n---\n\nencoded.\n`,
  raw: "x",
});

const okWorker: typeof runWorker = async (input) => ({
  handoff: okHandoff(
    input.feature.id,
    input.feature.assertions.map((a) => a.id),
  ),
  raw: "",
  attemptsUsed: 1,
});

describe("runFlow — happy path single feature", () => {
  test("worker pass → screwdriver pass → usertest pass → encode → complete", async () => {
    const contract = buildContract();
    await seedFlow(contract);
    const r = await runFlow({
      flow_id: FLOW,
      target_dir: TMP,
      target_url: "http://localhost:3000",
      backend: new MockBackend(() => ({ stdout: "" })),
      root: TMP,
      workerRun: okWorker,
      screwdriverRun: async (input) =>
        passReport(input.feature.id, ["A-001-001"], "screwdriver"),
      userTestRun: async (input) =>
        passReport(input.feature.id, ["A-001-002"], "user-test"),
      stewardEncodeRun: okEncode,
      maxIterations: 50,
    });
    expect(r.status).toBe("complete");

    // Artifacts written
    const dir = join(TMP, FLOW);
    const handoffs = await readdir(join(dir, "handoffs"));
    expect(handoffs).toContain("F-001__attempt-01.json");
    const reports = await readdir(join(dir, "reports"));
    expect(reports).toContain("F-001__screwdriver__attempt-01.json");
    expect(reports).toContain("F-001__usertest__attempt-01.json");
    const decisions = await readdir(join(dir, "decisions"));
    expect(decisions).toContain("F-001__attempt-01.md");
  });
});

describe("runFlow — corrective loop", () => {
  test("usertest fail → triage BROKEN_IMPL → corrective worker → pass → complete", async () => {
    const contract = buildContract();
    await seedFlow(contract);

    let workerCalls = 0;
    let userTestCalls = 0;

    const r = await runFlow({
      flow_id: FLOW,
      target_dir: TMP,
      target_url: "http://localhost:3000",
      backend: new MockBackend(() => ({ stdout: "" })),
      root: TMP,
      workerRun: async (input) => {
        workerCalls++;
        return {
          handoff: okHandoff(input.feature.id, ["A-001-001", "A-001-002"]),
          raw: "",
          attemptsUsed: 1,
        };
      },
      screwdriverRun: async (input) =>
        passReport(input.feature.id, ["A-001-001"], "screwdriver"),
      userTestRun: async (input) => {
        userTestCalls++;
        if (userTestCalls === 1) {
          return failReport(input.feature.id, ["A-001-002"], "user-test");
        }
        return passReport(input.feature.id, ["A-001-002"], "user-test");
      },
      stewardEncodeRun: okEncode,
      stewardTriageRun: async () => ({
        classification: "BROKEN_IMPL",
        rationale: "missing router.refresh()",
        new_assertions: [],
        raw: "{}",
      }),
      maxIterations: 50,
    });

    expect(r.status).toBe("complete");
    expect(workerCalls).toBe(2); // original + 1 corrective

    const dir = join(TMP, FLOW);
    const handoffs = await readdir(join(dir, "handoffs"));
    expect(handoffs).toContain("F-001__attempt-01.json");
    expect(handoffs).toContain("F-001__attempt-02.json"); // corrective
    const reports = await readdir(join(dir, "reports"));
    expect(reports).toContain("F-001__triage__attempt-01.json");

    // state.corrective_attempts incremented exactly once
    const stateRaw = await readFile(join(dir, "state.json"), "utf8");
    const state = JSON.parse(stateRaw);
    expect(state.corrective_attempts["F-001"]).toBe(1);
    expect(state.phase).toBe("complete");
  });
});

describe("runFlow — G3 cap", () => {
  test("5 corrective failures → state.phase=needs_human", async () => {
    const contract = buildContract();
    await seedFlow(contract);

    let corrCalls = 0;

    const r = await runFlow({
      flow_id: FLOW,
      target_dir: TMP,
      target_url: "http://localhost:3000",
      backend: new MockBackend(() => ({ stdout: "" })),
      root: TMP,
      workerRun: async (input) => {
        if (input.failures) corrCalls++;
        return {
          handoff: okHandoff(input.feature.id, ["A-001-001", "A-001-002"]),
          raw: "",
          attemptsUsed: 1,
        };
      },
      screwdriverRun: async (input) =>
        passReport(input.feature.id, ["A-001-001"], "screwdriver"),
      userTestRun: async (input) =>
        failReport(input.feature.id, ["A-001-002"], "user-test"), // ALWAYS fail
      stewardEncodeRun: okEncode,
      stewardTriageRun: async () => ({
        classification: "BROKEN_IMPL",
        rationale: "still broken",
        new_assertions: [],
        raw: "{}",
      }),
      maxIterations: 200,
    });

    expect(r.status).toBe("needs_human");
    expect(r.reason).toMatch(/G3/);
    expect(corrCalls).toBe(CORRECTIVE_CAP); // exactly 5 corrective attempts

    const dir = join(TMP, FLOW);
    const stateRaw = await readFile(join(dir, "state.json"), "utf8");
    const state = JSON.parse(stateRaw);
    expect(state.corrective_attempts["F-001"]).toBe(CORRECTIVE_CAP);
    expect(state.phase).toBe("needs_human");

    // Attempt history preserved: handoffs 01-06 (1 original + 5 corrective)
    const handoffs = await readdir(join(dir, "handoffs"));
    for (let n = 1; n <= CORRECTIVE_CAP + 1; n++) {
      expect(handoffs).toContain(
        `F-001__attempt-${String(n).padStart(2, "0")}.json`,
      );
    }
  });
});

describe("runFlow — MISSING_ASSERTION", () => {
  test("triage appends assertion and re-validates → complete", async () => {
    const contract = buildContract();
    await seedFlow(contract);

    let userTestCalls = 0;
    let triageCalls = 0;

    const r = await runFlow({
      flow_id: FLOW,
      target_dir: TMP,
      target_url: "http://localhost:3000",
      backend: new MockBackend(() => ({ stdout: "" })),
      root: TMP,
      workerRun: okWorker,
      screwdriverRun: async (input) =>
        passReport(input.feature.id, ["A-001-001"], "screwdriver"),
      userTestRun: async (input) => {
        userTestCalls++;
        if (userTestCalls === 1) {
          return failReport(input.feature.id, ["A-001-002"], "user-test");
        }
        // Second call: now feature has 2 user-test assertions, both pass
        return passReport(
          input.feature.id,
          input.feature.assertions
            .filter((a) => a.validator === "user-test")
            .map((a) => a.id),
          "user-test",
        );
      },
      stewardEncodeRun: okEncode,
      stewardTriageRun: async () => {
        triageCalls++;
        return {
          classification: "MISSING_ASSERTION",
          rationale: "scope expanded — logout was undertested",
          new_assertions: [
            {
              id: "A-001-099",
              text: "Clicking Logout clears session cookie within 2 seconds",
              validator: "user-test",
              evidence_required: "cookie inspection after click",
              user_check: {
                kind: "browser_flow",
                start: "target_url",
                steps: [{ kind: "click", selector: "#logout" }],
              },
              status: "pending",
              origin: "corrective",
              attempts: [],
            } as AssertionT,
          ],
          raw: "{}",
        };
      },
      maxIterations: 50,
    });

    expect(r.status).toBe("complete");
    expect(triageCalls).toBe(1);

    // Contract was rewritten to include the new assertion
    const dir = join(TMP, FLOW);
    const updated = await readContractYaml(join(dir, "contract.yaml"));
    const feature = updated.milestones[0]!.features[0]!;
    expect(feature.assertions.map((a) => a.id)).toContain("A-001-099");
    expect(feature.assertions.find((a) => a.id === "A-001-099")?.origin).toBe(
      "corrective",
    );

    // corrective_attempts NOT incremented for MISSING_ASSERTION
    const stateRaw = await readFile(join(dir, "state.json"), "utf8");
    const state = JSON.parse(stateRaw);
    expect(state.corrective_attempts["F-001"] ?? 0).toBe(0);
  });
});

describe("runFlow — INFRA halt", () => {
  test("usertest tool_error → triage forced INFRA → halt, no corrective", async () => {
    const contract = buildContract();
    await seedFlow(contract);

    let workerCalls = 0;
    const r = await runFlow({
      flow_id: FLOW,
      target_dir: TMP,
      target_url: "http://localhost:3000",
      backend: new MockBackend(() => ({ stdout: "" })),
      root: TMP,
      workerRun: async (input) => {
        workerCalls++;
        return {
          handoff: okHandoff(input.feature.id, ["A-001-001", "A-001-002"]),
          raw: "",
          attemptsUsed: 1,
        };
      },
      screwdriverRun: async (input) =>
        passReport(input.feature.id, ["A-001-001"], "screwdriver"),
      userTestRun: async (input) => toolErrorReport(input.feature.id),
      stewardEncodeRun: okEncode,
      maxIterations: 30,
    });

    expect(r.status).toBe("needs_human");
    expect(r.reason).toMatch(/INFRA/);
    expect(workerCalls).toBe(1); // ONLY original; no corrective ran

    const dir = join(TMP, FLOW);
    const stateRaw = await readFile(join(dir, "state.json"), "utf8");
    const state = JSON.parse(stateRaw);
    expect(state.corrective_attempts["F-001"] ?? 0).toBe(0); // never incremented
    expect(state.phase).toBe("needs_human");
  });

  test("triage classified INFRA (non-tool-error) → halt, no corrective", async () => {
    const contract = buildContract();
    await seedFlow(contract);

    let workerCalls = 0;
    const r = await runFlow({
      flow_id: FLOW,
      target_dir: TMP,
      target_url: "http://localhost:3000",
      backend: new MockBackend(() => ({ stdout: "" })),
      root: TMP,
      workerRun: async (input) => {
        workerCalls++;
        return {
          handoff: okHandoff(input.feature.id, ["A-001-001", "A-001-002"]),
          raw: "",
          attemptsUsed: 1,
        };
      },
      screwdriverRun: async (input) =>
        failReport(input.feature.id, ["A-001-001"], "screwdriver"),
      userTestRun: async (input) =>
        passReport(input.feature.id, ["A-001-002"], "user-test"),
      stewardEncodeRun: okEncode,
      stewardTriageRun: async () => ({
        classification: "INFRA",
        rationale: "node modules corrupt; not app code",
        new_assertions: [],
        raw: "{}",
      }),
      maxIterations: 30,
    });

    expect(r.status).toBe("needs_human");
    expect(workerCalls).toBe(1);
  });
});

describe("runFlow — phase gates", () => {
  test("phase=planning + approve=false → awaiting_approval (no iterations)", async () => {
    const contract = buildContract();
    await seedFlow(contract);
    // override state to planning
    const dir = join(TMP, FLOW);
    await writeFile(
      join(dir, "state.json"),
      JSON.stringify({ ...initialState(), phase: "planning" }, null, 2),
      "utf8",
    );
    const r = await runFlow({
      flow_id: FLOW,
      target_dir: TMP,
      target_url: "http://localhost:3000",
      backend: new MockBackend(() => ({ stdout: "" })),
      root: TMP,
    });
    expect(r.status).toBe("awaiting_approval");
    expect(r.iterations).toBe(0);
  });

  test("phase=complete on entry → returns complete immediately", async () => {
    const contract = buildContract();
    await seedFlow(contract);
    const dir = join(TMP, FLOW);
    await writeFile(
      join(dir, "state.json"),
      JSON.stringify({ ...initialState(), phase: "complete" }, null, 2),
      "utf8",
    );
    const r = await runFlow({
      flow_id: FLOW,
      target_dir: TMP,
      target_url: "http://localhost:3000",
      backend: new MockBackend(() => ({ stdout: "" })),
      root: TMP,
    });
    expect(r.status).toBe("complete");
    expect(r.iterations).toBe(0);
  });
});

describe("runFlow — pause, lock recovery, and worktrees", () => {
  test("pause request stops before launching the next action", async () => {
    const contract = buildContract();
    await seedFlow(contract);
    await writeControl(FLOW, { pause_requested: true, reason: "test pause" }, TMP);

    let workerCalls = 0;
    const r = await runFlow({
      flow_id: FLOW,
      target_dir: TMP,
      target_url: "http://localhost:3000",
      backend: new MockBackend(() => ({ stdout: "" })),
      root: TMP,
      workerRun: async (input) => {
        workerCalls++;
        return okWorker(input);
      },
      maxIterations: 10,
    });

    expect(r.status).toBe("paused");
    expect(workerCalls).toBe(0);
    const state = JSON.parse(await readFile(join(TMP, FLOW, "state.json"), "utf8"));
    expect(state.phase).toBe("paused");
  });

  test("resume clears paused phase and continues the same flow", async () => {
    const contract = buildContract();
    await seedFlow(contract);
    await writeState({ ...initialState(), phase: "paused" }, TMP);
    await writeControl(FLOW, { pause_requested: false }, TMP);

    const r = await runFlow({
      flow_id: FLOW,
      target_dir: TMP,
      target_url: "http://localhost:3000",
      backend: new MockBackend(() => ({ stdout: "" })),
      root: TMP,
      approve: true,
      workerRun: okWorker,
      screwdriverRun: async (input) =>
        passReport(input.feature.id, ["A-001-001"], "screwdriver"),
      userTestRun: async (input) =>
        passReport(input.feature.id, ["A-001-002"], "user-test"),
      stewardEncodeRun: okEncode,
      maxIterations: 50,
    });
    expect(r.status).toBe("complete");
  });

  test("live run.lock blocks a second runner", async () => {
    const contract = buildContract();
    await seedFlow(contract);
    const now = new Date().toISOString();
    await writeFile(
      lockPath(FLOW, TMP),
      JSON.stringify({ pid: process.pid, started_at: now, heartbeat_at: now }, null, 2),
      "utf8",
    );
    await expect(
      runFlow({
        flow_id: FLOW,
        target_dir: TMP,
        target_url: "http://localhost:3000",
        backend: new MockBackend(() => ({ stdout: "" })),
        root: TMP,
      }),
    ).rejects.toThrow(RunLockError);
  });

  test("stale run.lock is archived and flow resumes", async () => {
    const contract = buildContract();
    await seedFlow(contract);
    await writeState({ ...initialState(), phase: "complete" }, TMP);
    await writeFile(
      lockPath(FLOW, TMP),
      JSON.stringify({
        pid: 999999,
        started_at: "2020-01-01T00:00:00.000Z",
        heartbeat_at: "2020-01-01T00:00:00.000Z",
      }, null, 2),
      "utf8",
    );
    const r = await runFlow({
      flow_id: FLOW,
      target_dir: TMP,
      target_url: "http://localhost:3000",
      backend: new MockBackend(() => ({ stdout: "" })),
      root: TMP,
      lockStaleMs: 1,
    });
    expect(r.status).toBe("complete");
    const files = await readdir(join(TMP, FLOW));
    expect(files.some((f) => f.startsWith("run.lock.stale-"))).toBe(true);
  });

  test("passing worktree merges back into target_dir", async () => {
    const contract = buildContract();
    await seedFlow(contract);
    const target = join(TMP, "git-target-pass");
    await initGitTarget(target);

    const r = await runFlow({
      flow_id: FLOW,
      target_dir: target,
      target_url: "http://localhost:3000",
      backend: new MockBackend(() => ({ stdout: "" })),
      root: TMP,
      workerRun: async (input) => {
        await writeFile(join(input.target_dir, "app.txt"), "feature shipped\n", "utf8");
        return okWorker(input);
      },
      screwdriverRun: async (input) =>
        passReport(input.feature.id, ["A-001-001"], "screwdriver"),
      userTestRun: async (input) =>
        passReport(input.feature.id, ["A-001-002"], "user-test"),
      stewardEncodeRun: okEncode,
      maxIterations: 50,
    });
    expect(r.status).toBe("complete");
    expect(await readFile(join(target, "app.txt"), "utf8")).toContain("feature shipped");
  });

  test("failing worktree remains inspectable and target_dir is unchanged", async () => {
    const contract = buildContract();
    await seedFlow(contract);
    const target = join(TMP, "git-target-fail");
    await initGitTarget(target);

    const r = await runFlow({
      flow_id: FLOW,
      target_dir: target,
      target_url: "http://localhost:3000",
      backend: new MockBackend(() => ({ stdout: "" })),
      root: TMP,
      workerRun: async (input) => {
        await writeFile(join(input.target_dir, "app.txt"), "broken attempt\n", "utf8");
        return okWorker(input);
      },
      screwdriverRun: async (input) =>
        passReport(input.feature.id, ["A-001-001"], "screwdriver"),
      userTestRun: async (input) =>
        failReport(input.feature.id, ["A-001-002"], "user-test"),
      stewardEncodeRun: okEncode,
      stewardTriageRun: async () => ({
        classification: "INFRA",
        rationale: "stop after failing worktree",
        new_assertions: [],
        raw: "{}",
      }),
      maxIterations: 50,
    });
    expect(r.status).toBe("needs_human");
    expect(await readFile(join(target, "app.txt"), "utf8")).toContain("base");
    const wt = featureWorktreePath(join(TMP, FLOW), "F-001", 1);
    expect(await readFile(join(wt, "app.txt"), "utf8")).toContain("broken attempt");
  });

  test("replay after interruption does not duplicate completed worker artifacts", async () => {
    const contract = buildContract();
    await seedFlow(contract);
    let workerCalls = 0;
    const worker: typeof runWorker = async (input) => {
      workerCalls++;
      return okWorker(input);
    };
    await expect(
      runFlow({
        flow_id: FLOW,
        target_dir: TMP,
        target_url: "http://localhost:3000",
        backend: new MockBackend(() => ({ stdout: "" })),
        root: TMP,
        workerRun: worker,
        maxIterations: 1,
      }),
    ).rejects.toThrow(/exceeded max iterations/);

    const r = await runFlow({
      flow_id: FLOW,
      target_dir: TMP,
      target_url: "http://localhost:3000",
      backend: new MockBackend(() => ({ stdout: "" })),
      root: TMP,
      workerRun: worker,
      screwdriverRun: async (input) =>
        passReport(input.feature.id, ["A-001-001"], "screwdriver"),
      userTestRun: async (input) =>
        passReport(input.feature.id, ["A-001-002"], "user-test"),
      stewardEncodeRun: okEncode,
      maxIterations: 50,
    });
    expect(r.status).toBe("complete");
    expect(workerCalls).toBe(1);
    const handoffs = await readdir(join(TMP, FLOW, "handoffs"));
    expect(handoffs.filter((f) => f === "F-001__attempt-01.json")).toHaveLength(1);
  });
});

describe("appendAssertions helper", () => {
  test("appends assertions tagged origin=corrective", () => {
    const c = buildContract();
    const updated = appendAssertions(c, "F-001", [
      {
        id: "A-NEW",
        text: "Some new check",
        validator: "screwdriver",
        evidence_required: "log",
        check: { kind: "command", cmd: ["true"], expected_exit_code: 0 },
        status: "pending",
        origin: "original",
        attempts: [],
      } as AssertionT,
    ]);
    const f = updated.milestones[0]!.features[0]!;
    const newA = f.assertions.find((a) => a.id === "A-NEW")!;
    expect(newA.origin).toBe("corrective");
  });
});

async function initGitTarget(target: string): Promise<void> {
  await mkdir(target, { recursive: true });
  await writeFile(join(target, "app.txt"), "base\n", "utf8");
  await git(target, ["init", "-q"]);
  await git(target, ["config", "user.email", "gflow@test.local"]);
  await git(target, ["config", "user.name", "G Flow Test"]);
  await git(target, ["add", "-A"]);
  await git(target, ["commit", "-m", "base"]);
}

async function git(cwd: string, args: string[]): Promise<void> {
  const r = await spawnPiped(["git", ...args], { cwd, timeoutMs: 60_000 });
  if (!r.ok) throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
}

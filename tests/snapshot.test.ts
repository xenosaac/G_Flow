import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readSnapshot, readLatestSnapshot } from "../src/console/lib/snapshot.ts";
import { writeContractYaml } from "../src/runtime/contract-io.ts";
import { writeState } from "../src/runtime/state.ts";
import { Contract } from "../src/artifacts/contract.ts";
import { Handoff } from "../src/artifacts/handoff.ts";
import { ValidatorReport } from "../src/artifacts/reports.ts";
import type { FlowStateT } from "../src/artifacts/state.ts";

let TMP: string;
let prevRoot: string | undefined;
const FLOW = "f_snap_0001";

beforeEach(async () => {
  TMP = join(
    tmpdir(),
    `gflow-snap-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  await mkdir(join(TMP, FLOW, "handoffs"), { recursive: true });
  await mkdir(join(TMP, FLOW, "reports"), { recursive: true });
  await mkdir(join(TMP, FLOW, "decisions"), { recursive: true });
  prevRoot = process.env.GFLOW_ROOT;
  process.env.GFLOW_ROOT = TMP;
});

afterEach(async () => {
  if (prevRoot === undefined) delete process.env.GFLOW_ROOT;
  else process.env.GFLOW_ROOT = prevRoot;
  await rm(TMP, { recursive: true, force: true });
});

function makeState(overrides: Partial<FlowStateT> = {}): FlowStateT {
  return {
    flow_id: FLOW,
    phase: "executing",
    current_milestone: "M-001",
    current_feature: "F-001",
    current_step: "usertest",
    corrective_attempts: {},
    counters: { llm_calls: 1, tokens_in: 100, tokens_out: 50, usd_spent: 0.005 },
    started_at: "2026-05-16T10:00:00.000Z",
    updated_at: "2026-05-16T10:01:00.000Z",
    ...overrides,
  };
}

const contract = Contract.parse({
  flow_id: FLOW,
  goal: "build a todo app",
  created_at: "2026-05-16T10:00:00.000Z",
  milestones: [
    {
      id: "M-001",
      title: "Auth",
      endpoint_criteria: "auth works",
      features: [
        {
          id: "F-001",
          title: "Signup",
          spec: "POST /api/auth/signup",
          assertions: [
            {
              id: "A-001-001",
              text: "POST returns 201",
              validator: "screwdriver",
              evidence_required: "HTTP capture",
            },
          ],
        },
      ],
    },
  ],
});

describe("readSnapshot", () => {
  test("returns null when flow_id missing", async () => {
    const s = await readSnapshot("does_not_exist");
    expect(s).toBeNull();
  });

  test("returns a snapshot with state + contract + counters", async () => {
    await writeState(makeState(), TMP);
    await writeContractYaml(contract, join(TMP, FLOW, "contract.yaml"));
    await writeFile(join(TMP, FLOW, "goal.txt"), "build a todo app\n", "utf8");
    const s = await readSnapshot(FLOW);
    expect(s).not.toBeNull();
    expect(s!.flow_id).toBe(FLOW);
    expect(s!.goal).toBe("build a todo app");
    expect(s!.state.phase).toBe("executing");
    expect(s!.contract).not.toBeNull();
    expect(s!.contract!.milestones[0]!.features[0]!.id).toBe("F-001");
  });

  test("picks up latest handoff and validator reports for current feature", async () => {
    await writeState(makeState(), TMP);
    await writeContractYaml(contract, join(TMP, FLOW, "contract.yaml"));

    const handoff = Handoff.parse({
      flow_id: FLOW,
      feature_id: "F-001",
      completed: true,
      recorded_at: "2026-05-16T11:00:00.000Z",
    });
    await writeFile(
      join(TMP, FLOW, "handoffs", "F-001__attempt-01.json"),
      JSON.stringify(handoff),
      "utf8",
    );
    const report = ValidatorReport.parse({
      feature_id: "F-001",
      flow_id: FLOW,
      validator: "screwdriver",
      status: "pass",
      assertion_results: [
        { assertion_id: "A-001-001", outcome: "pass", detail: "" },
      ],
      raw_stdout_tail: "",
      raw_stderr_tail: "",
      recorded_at: "2026-05-16T11:30:00.000Z",
      steward_hint: "NONE",
    });
    await writeFile(
      join(TMP, FLOW, "reports", "F-001__screwdriver__attempt-01.json"),
      JSON.stringify(report),
      "utf8",
    );

    const s = await readSnapshot(FLOW);
    expect(s!.latest.handoff?.completed).toBe(true);
    expect(s!.latest.screwdriver?.status).toBe("pass");
    expect(s!.attempt_history["F-001"]?.attempts).toBe(1);
  });

  test("synthesizes needs_human_reason from triage classification", async () => {
    await writeState(makeState({ phase: "needs_human" }), TMP);
    await writeContractYaml(contract, join(TMP, FLOW, "contract.yaml"));
    const triage = {
      classification: "INFRA",
      rationale: "browser-use crashed",
      new_assertions: [],
    };
    await writeFile(
      join(TMP, FLOW, "reports", "F-001__triage__attempt-01.json"),
      JSON.stringify(triage),
      "utf8",
    );
    const s = await readSnapshot(FLOW);
    expect(s!.needs_human_reason).toMatch(/INFRA/);
    expect(s!.needs_human_reason).toMatch(/browser-use crashed/);
  });

  test("synthesizes needs_human_reason from usertest tool_error when no triage on disk", async () => {
    await writeState(makeState({ phase: "needs_human" }), TMP);
    await writeContractYaml(contract, join(TMP, FLOW, "contract.yaml"));
    const ut = ValidatorReport.parse({
      feature_id: "F-001",
      flow_id: FLOW,
      validator: "user-test",
      status: "tool_error",
      assertion_results: [],
      raw_stdout_tail: "",
      raw_stderr_tail: "ENOENT: python3 not found",
      recorded_at: "2026-05-16T12:00:00.000Z",
      steward_hint: "INFRA",
    });
    await writeFile(
      join(TMP, FLOW, "reports", "F-001__usertest__attempt-01.json"),
      JSON.stringify(ut),
      "utf8",
    );
    const s = await readSnapshot(FLOW);
    expect(s!.needs_human_reason).toMatch(/tool_error/);
  });
});

describe("readLatestSnapshot", () => {
  test("returns null when no flow exists", async () => {
    const s = await readLatestSnapshot();
    expect(s).toBeNull();
  });

  test("returns snapshot for the most recent flow", async () => {
    await writeState(makeState(), TMP);
    await writeContractYaml(contract, join(TMP, FLOW, "contract.yaml"));
    const s = await readLatestSnapshot();
    expect(s?.flow_id).toBe(FLOW);
  });
});

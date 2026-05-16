import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startFlowAPI, resumeFlowAPI } from "../src/runtime/flow-control.ts";
import { MockBackend } from "../src/adapters/mock.ts";
import { writeContractYaml } from "../src/runtime/contract-io.ts";
import { writeState } from "../src/runtime/state.ts";
import { Contract } from "../src/artifacts/contract.ts";

const goodTree = {
  milestones: [
    {
      id: "M-001",
      title: "Static",
      endpoint_criteria: "page renders",
      features: [
        {
          id: "F-001",
          title: "index.html",
          spec: "Create index.html with a Buy milk form",
          assertions: [
            {
              id: "A-001-001",
              text: "index.html exists in target_dir",
              validator: "screwdriver",
              evidence_required: "ls",
              check: { kind: "file_exists", path: "index.html" },
            },
          ],
        },
      ],
    },
  ],
};

let TMP: string;
let prevRoot: string | undefined;

beforeEach(async () => {
  TMP = join(
    tmpdir(),
    `gflow-fctl-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  await mkdir(TMP, { recursive: true });
  prevRoot = process.env.GFLOW_ROOT;
  process.env.GFLOW_ROOT = TMP;
});

afterEach(async () => {
  if (prevRoot === undefined) delete process.env.GFLOW_ROOT;
  else process.env.GFLOW_ROOT = prevRoot;
  await rm(TMP, { recursive: true, force: true });
});

describe("startFlowAPI", () => {
  test("mints flow_id, writes contract.yaml + goal.txt, returns counts", async () => {
    const backend = new MockBackend(() => ({ stdout: JSON.stringify(goodTree) }));
    const r = await startFlowAPI({
      goal: "build a static todo app",
      backend,
      root: TMP,
    });
    expect(r.flow_id).toMatch(/^f_\d{4}_\d{2}_\d{2}_\d{4}$/);
    expect(r.milestones).toBe(1);
    expect(r.features).toBe(1);
    expect(r.assertions).toBe(1);

    const yaml = await readFile(r.contract_path, "utf8");
    expect(yaml).toContain("flow_id: " + r.flow_id);
    expect(yaml).toContain("Buy milk");

    const goal = await readFile(join(r.flow_dir, "goal.txt"), "utf8");
    expect(goal.trim()).toBe("build a static todo app");
  });

  test("empty goal throws clearly", async () => {
    const backend = new MockBackend(() => ({ stdout: "" }));
    await expect(
      startFlowAPI({ goal: "  ", backend, root: TMP }),
    ).rejects.toThrow(/goal required/);
  });

  test("planner G1 failure bubbles a PlannerError with issues", async () => {
    const vague = {
      milestones: [
        {
          id: "M-001",
          title: "x",
          endpoint_criteria: "x",
          features: [
            {
              id: "F-001",
              title: "x",
              spec: "x",
              assertions: [
                {
                  id: "A-001-001",
                  text: "the app should be robust and good",
                  validator: "user-test",
                  evidence_required: "vibes",
                },
              ],
            },
          ],
        },
      ],
    };
    const backend = new MockBackend(() => ({ stdout: JSON.stringify(vague) }));
    let err: unknown = null;
    try {
      await startFlowAPI({ goal: "x", backend, root: TMP });
    } catch (e) {
      err = e;
    }
    expect(err).not.toBeNull();
    expect((err as Error).name).toBe("PlannerError");
  });
});

describe("resumeFlowAPI", () => {
  test("no resumable flow → throws", async () => {
    const backend = new MockBackend(() => ({ stdout: "" }));
    await expect(
      resumeFlowAPI({ backend, root: TMP }),
    ).rejects.toThrow(/no resumable flow/);
  });

  test("resumes the latest flow when flow_id is omitted (via override)", async () => {
    // seed a flow at planning
    const contract = Contract.parse({
      flow_id: "f_2026_05_16_9999",
      goal: "x",
      created_at: "2026-05-16T10:00:00.000Z",
      milestones: goodTree.milestones,
    });
    const flowDir = join(TMP, contract.flow_id);
    await mkdir(join(flowDir, "handoffs"), { recursive: true });
    await mkdir(join(flowDir, "reports"), { recursive: true });
    await mkdir(join(flowDir, "decisions"), { recursive: true });
    await mkdir(join(flowDir, "features"), { recursive: true });
    await writeContractYaml(contract, join(flowDir, "contract.yaml"));
    await writeState(
      {
        flow_id: contract.flow_id,
        phase: "planning",
        current_milestone: null,
        current_feature: null,
        current_step: null,
        corrective_attempts: {},
        counters: { llm_calls: 0, tokens_in: 0, tokens_out: 0, usd_spent: 0 },
        started_at: "2026-05-16T10:00:00.000Z",
        updated_at: "2026-05-16T10:00:00.000Z",
      },
      TMP,
    );

    const backend = new MockBackend(() => ({ stdout: "" }));
    // override runFlow with a fast stub
    const r = await resumeFlowAPI({
      backend,
      root: TMP,
      target_dir: TMP,
      runFlowOverride: async (opts) => {
        expect(opts.approve).toBe(true);
        return { status: "complete", iterations: 1 };
      },
    });
    expect(r.flow_id).toBe(contract.flow_id);
    expect(r.status).toBe("complete");
    expect(r.iterations).toBe(1);
  });
});

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { clarifyFlowAPI, startFlowAPI, resumeFlowAPI } from "../src/runtime/flow-control.ts";
import { MockBackend } from "../src/adapters/mock.ts";
import { writeContractYaml } from "../src/runtime/contract-io.ts";
import { writeState } from "../src/runtime/state.ts";
import { Contract } from "../src/artifacts/contract.ts";
import type { PlanningReviewProvider } from "../src/runtime/planning-review.ts";

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

const readyReviewProvider: PlanningReviewProvider = {
  async runIntake() {
    return {
      status: "ready",
      brief_md: "Build the requested static app.",
      assumptions: [],
    };
  },
  async runEngineeringReview(_goal, _brief, draft) {
    return { status: "ready", contract: draft, raw: "{}" };
  },
};

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
      planningReviewProvider: readyReviewProvider,
    });
    expect(r.status).toBe("ready");
    expect(r.flow_id).toMatch(/^f_\d{4}_\d{2}_\d{2}_\d{4}$/);
    if (r.status !== "ready") throw new Error("expected ready");
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
      await startFlowAPI({
        goal: "x",
        backend,
        root: TMP,
        planningReviewProvider: readyReviewProvider,
      });
    } catch (e) {
      err = e;
    }
    expect(err).not.toBeNull();
    expect((err as Error).name).toBe("PlannerError");
  });

  test("vague intake returns clarification questions and no contract", async () => {
    const backend = new MockBackend(() => ({ stdout: JSON.stringify(goodTree) }));
    const r = await startFlowAPI({
      goal: "build a website",
      backend,
      root: TMP,
      planningReviewProvider: {
        async runIntake() {
          return {
            status: "needs_clarification",
            questions: [{ id: "q1", text: "What kind of website?", why: "Defines scope." }],
          };
        },
        async runEngineeringReview(_goal, _brief, draft) {
          return { status: "ready", contract: draft, raw: "{}" };
        },
      },
    });
    expect(r.status).toBe("needs_clarification");
    if (r.status !== "needs_clarification") throw new Error("expected questions");
    expect(r.questions[0]!.id).toBe("q1");
    await expect(readFile(join(r.flow_dir, "contract.yaml"), "utf8")).rejects.toThrow();
    const state = JSON.parse(await readFile(join(r.flow_dir, "state.json"), "utf8"));
    expect(state.phase).toBe("clarifying");
  });

  test("answering clarification eventually writes contract and moves to planning", async () => {
    const backend = new MockBackend(() => ({ stdout: JSON.stringify(goodTree) }));
    const provider: PlanningReviewProvider = {
      async runIntake(_goal, history) {
        if (history.length === 0) {
          return {
            status: "needs_clarification",
            questions: [{ id: "q1", text: "What kind of app?", why: "Defines scope." }],
          };
        }
        return {
          status: "ready",
          brief_md: `Build a static todo app. Answer: ${history[0]!.answer}`,
          assumptions: [],
        };
      },
      async runEngineeringReview(_goal, _brief, draft) {
        return { status: "ready", contract: draft, raw: "{}" };
      },
    };
    const started = await startFlowAPI({
      goal: "build something",
      backend,
      root: TMP,
      planningReviewProvider: provider,
    });
    expect(started.status).toBe("needs_clarification");
    const clarified = await clarifyFlowAPI({
      flow_id: started.flow_id,
      answers: [{ question_id: "q1", answer: "A static todo app." }],
      backend,
      root: TMP,
      planningReviewProvider: provider,
    });
    expect(clarified.status).toBe("ready");
    if (clarified.status !== "ready") throw new Error("expected ready");
    expect(clarified.features).toBe(1);
    const state = JSON.parse(await readFile(join(clarified.flow_dir, "state.json"), "utf8"));
    expect(state.phase).toBe("planning");
    const yaml = await readFile(clarified.contract_path, "utf8");
    expect(yaml).toContain("flow_id: " + clarified.flow_id);
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

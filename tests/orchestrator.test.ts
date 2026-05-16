import { describe, test, expect } from "bun:test";
import { nextAction, CORRECTIVE_CAP } from "../src/runtime/orchestrator.ts";
import type { FlowStateT } from "../src/artifacts/state.ts";
import type { ContractT } from "../src/artifacts/contract.ts";
import type { ValidatorReportT } from "../src/artifacts/reports.ts";

const fixedISO = "2026-05-16T10:00:00.000Z";

function makeContract(): ContractT {
  return {
    flow_id: "f_test_0001",
    goal: "build a todo app",
    created_at: fixedISO,
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
                text: "POST /signup returns 201 with token",
                validator: "screwdriver",
                evidence_required: "HTTP capture",
                status: "pending",
                origin: "original",
                attempts: [],
              },
              {
                id: "A-001-002",
                text: "Signup form redirects to /dashboard",
                validator: "user-test",
                evidence_required: "screenshot",
                status: "pending",
                origin: "original",
                attempts: [],
              },
            ],
          },
          {
            id: "F-002",
            title: "Login",
            spec: "POST /api/auth/login",
            assertions: [
              {
                id: "A-002-001",
                text: "POST /login returns 200 with token",
                validator: "screwdriver",
                evidence_required: "HTTP capture",
                status: "pending",
                origin: "original",
                attempts: [],
              },
            ],
          },
        ],
      },
      {
        id: "M-002",
        title: "Todos",
        endpoint_criteria: "todos work",
        features: [
          {
            id: "F-003",
            title: "Create todo",
            spec: "POST /api/todos",
            assertions: [
              {
                id: "A-003-001",
                text: "POST /api/todos returns 201",
                validator: "screwdriver",
                evidence_required: "HTTP capture",
                status: "pending",
                origin: "original",
                attempts: [],
              },
            ],
          },
        ],
      },
    ],
  };
}

function makeState(overrides: Partial<FlowStateT>): FlowStateT {
  return {
    flow_id: "f_test_0001",
    phase: "executing",
    current_milestone: null,
    current_feature: null,
    current_step: null,
    corrective_attempts: {},
    counters: { llm_calls: 0, tokens_in: 0, tokens_out: 0, usd_spent: 0 },
    started_at: fixedISO,
    updated_at: fixedISO,
    ...overrides,
  };
}

const passReport = (feature_id: string, ids: string[], validator: "screwdriver" | "user-test"): ValidatorReportT => ({
  feature_id,
  flow_id: "f_test_0001",
  validator,
  status: "pass",
  assertion_results: ids.map((id) => ({ assertion_id: id, outcome: "pass" as const, detail: "" })),
  raw_stdout_tail: "",
  raw_stderr_tail: "",
  recorded_at: fixedISO,
  steward_hint: "NONE",
});

const failReport = (feature_id: string, ids: string[], validator: "screwdriver" | "user-test"): ValidatorReportT => ({
  feature_id,
  flow_id: "f_test_0001",
  validator,
  status: "fail",
  assertion_results: ids.map((id) => ({ assertion_id: id, outcome: "fail" as const, detail: "bad" })),
  raw_stdout_tail: "",
  raw_stderr_tail: "",
  recorded_at: fixedISO,
  steward_hint: "NONE",
});

const toolErrorReport = (feature_id: string): ValidatorReportT => ({
  feature_id,
  flow_id: "f_test_0001",
  validator: "user-test",
  status: "tool_error",
  assertion_results: [],
  raw_stdout_tail: "",
  raw_stderr_tail: "subprocess crashed",
  recorded_at: fixedISO,
  steward_hint: "INFRA",
});

describe("nextAction — terminal phases", () => {
  test("planning → halt(awaiting_approval)", () => {
    const action = nextAction({
      state: makeState({ phase: "planning" }),
      contract: makeContract(),
    });
    expect(action.type).toBe("halt");
    if (action.type === "halt") expect(action.reason).toBe("awaiting_approval");
  });

  test("needs_human → halt(needs_human)", () => {
    const action = nextAction({
      state: makeState({ phase: "needs_human" }),
      contract: makeContract(),
    });
    expect(action.type).toBe("halt");
    if (action.type === "halt") expect(action.reason).toBe("needs_human");
  });

  test("complete → complete", () => {
    const action = nextAction({
      state: makeState({ phase: "complete" }),
      contract: makeContract(),
    });
    expect(action.type).toBe("complete");
  });
});

describe("nextAction — entry into Phase 2", () => {
  test("executing with no current feature → worker on F-001 attempt=1", () => {
    const action = nextAction({
      state: makeState({ phase: "executing" }),
      contract: makeContract(),
    });
    expect(action.type).toBe("worker");
    if (action.type === "worker") {
      expect(action.feature.id).toBe("F-001");
      expect(action.milestone_id).toBe("M-001");
      expect(action.attempt).toBe(1);
      expect(action.mode).toBe("original");
    }
  });
});

describe("nextAction — happy path step sequence", () => {
  const ctx = {
    state: makeState({
      phase: "executing",
      current_milestone: "M-001",
      current_feature: "F-001",
      current_step: "worker",
    }),
    contract: makeContract(),
  };

  test("after worker → screwdriver", () => {
    const action = nextAction(ctx);
    expect(action.type).toBe("screwdriver");
  });

  test("after screwdriver → usertest", () => {
    const action = nextAction({
      ...ctx,
      state: { ...ctx.state, current_step: "screwdriver" },
    });
    expect(action.type).toBe("usertest");
  });

  test("after usertest with all passing → steward_encode(passing)", () => {
    const action = nextAction({
      ...ctx,
      state: { ...ctx.state, current_step: "usertest" },
      lastScrewdriver: passReport("F-001", ["A-001-001"], "screwdriver"),
      lastUserTest: passReport("F-001", ["A-001-002"], "user-test"),
    });
    expect(action.type).toBe("steward_encode");
    if (action.type === "steward_encode") {
      expect(action.outcome).toBe("passing");
      expect(action.failures).toEqual([]);
    }
  });

  test("after usertest with screwdriver failing → steward_encode(failing) with failure list", () => {
    const action = nextAction({
      ...ctx,
      state: { ...ctx.state, current_step: "usertest" },
      lastScrewdriver: failReport("F-001", ["A-001-001"], "screwdriver"),
      lastUserTest: passReport("F-001", ["A-001-002"], "user-test"),
    });
    expect(action.type).toBe("steward_encode");
    if (action.type === "steward_encode") {
      expect(action.outcome).toBe("failing");
      expect(action.failures).toHaveLength(1);
      expect(action.failures[0]!.assertion_id).toBe("A-001-001");
    }
  });
});

describe("nextAction — G2 (usertest tool_error)", () => {
  test("usertest tool_error → steward_triage with INFRA hint, no failures", () => {
    const action = nextAction({
      state: makeState({
        phase: "executing",
        current_milestone: "M-001",
        current_feature: "F-001",
        current_step: "usertest",
      }),
      contract: makeContract(),
      lastScrewdriver: passReport("F-001", ["A-001-001"], "screwdriver"),
      lastUserTest: toolErrorReport("F-001"),
    });
    expect(action.type).toBe("steward_triage");
    if (action.type === "steward_triage") {
      expect(action.hint).toBe("INFRA");
      expect(action.failures).toEqual([]);
    }
  });
});

describe("nextAction — advance + complete", () => {
  test("steward_encode with all passing on F-001 → advance to F-002", () => {
    const action = nextAction({
      state: makeState({
        phase: "executing",
        current_milestone: "M-001",
        current_feature: "F-001",
        current_step: "steward_encode",
      }),
      contract: makeContract(),
      lastScrewdriver: passReport("F-001", ["A-001-001"], "screwdriver"),
      lastUserTest: passReport("F-001", ["A-001-002"], "user-test"),
    });
    expect(action.type).toBe("advance");
    if (action.type === "advance") {
      expect(action.from).toEqual({ milestone_id: "M-001", feature_id: "F-001" });
      expect(action.to).toEqual({ milestone_id: "M-001", feature_id: "F-002" });
    }
  });

  test("steward_encode on F-002 (last in M-001) → advance into M-002 F-003", () => {
    const action = nextAction({
      state: makeState({
        phase: "executing",
        current_milestone: "M-001",
        current_feature: "F-002",
        current_step: "steward_encode",
      }),
      contract: makeContract(),
      lastScrewdriver: passReport("F-002", ["A-002-001"], "screwdriver"),
      lastUserTest: passReport("F-002", [], "user-test"),
    });
    expect(action.type).toBe("advance");
    if (action.type === "advance") {
      expect(action.to).toEqual({ milestone_id: "M-002", feature_id: "F-003" });
    }
  });

  test("steward_encode on last feature with all passing → complete", () => {
    const action = nextAction({
      state: makeState({
        phase: "executing",
        current_milestone: "M-002",
        current_feature: "F-003",
        current_step: "steward_encode",
      }),
      contract: makeContract(),
      lastScrewdriver: passReport("F-003", ["A-003-001"], "screwdriver"),
      lastUserTest: passReport("F-003", [], "user-test"),
    });
    expect(action.type).toBe("complete");
  });

  test("steward_encode with failures → steward_triage", () => {
    const action = nextAction({
      state: makeState({
        phase: "executing",
        current_milestone: "M-001",
        current_feature: "F-001",
        current_step: "steward_encode",
      }),
      contract: makeContract(),
      lastScrewdriver: passReport("F-001", ["A-001-001"], "screwdriver"),
      lastUserTest: failReport("F-001", ["A-001-002"], "user-test"),
    });
    expect(action.type).toBe("steward_triage");
    if (action.type === "steward_triage") {
      expect(action.failures).toHaveLength(1);
    }
  });
});

describe("nextAction — triage routing", () => {
  test("triage=INFRA → halt(needs_human)", () => {
    const action = nextAction({
      state: makeState({
        phase: "executing",
        current_milestone: "M-001",
        current_feature: "F-001",
        current_step: "steward_triage",
      }),
      contract: makeContract(),
      lastTriage: { classification: "INFRA" },
    });
    expect(action.type).toBe("halt");
    if (action.type === "halt") {
      expect(action.reason).toBe("needs_human");
      expect(action.detail).toContain("INFRA");
    }
  });

  test("triage=BROKEN_IMPL with corrective<5 → corrective_worker", () => {
    const action = nextAction({
      state: makeState({
        phase: "executing",
        current_milestone: "M-001",
        current_feature: "F-001",
        current_step: "steward_triage",
        corrective_attempts: { "F-001": 2 },
      }),
      contract: makeContract(),
      lastScrewdriver: passReport("F-001", ["A-001-001"], "screwdriver"),
      lastUserTest: failReport("F-001", ["A-001-002"], "user-test"),
      lastTriage: { classification: "BROKEN_IMPL" },
    });
    expect(action.type).toBe("corrective_worker");
    if (action.type === "corrective_worker") {
      // 2 prior corrections done, original was attempt 1 → this is feature attempt 4
      expect(action.attempt).toBe(4);
      expect(action.failures).toHaveLength(1);
    }
  });

  test("triage=BROKEN_IMPL with corrective=0 → corrective_worker attempt=2", () => {
    const action = nextAction({
      state: makeState({
        phase: "executing",
        current_milestone: "M-001",
        current_feature: "F-001",
        current_step: "steward_triage",
      }),
      contract: makeContract(),
      lastTriage: { classification: "BROKEN_IMPL" },
    });
    expect(action.type).toBe("corrective_worker");
    if (action.type === "corrective_worker") {
      expect(action.attempt).toBe(2); // original was attempt 1; first corrective is attempt 2
    }
  });

  test("G3: triage=BROKEN_IMPL with corrective at cap → halt(needs_human)", () => {
    const action = nextAction({
      state: makeState({
        phase: "executing",
        current_milestone: "M-001",
        current_feature: "F-001",
        current_step: "steward_triage",
        corrective_attempts: { "F-001": CORRECTIVE_CAP },
      }),
      contract: makeContract(),
      lastTriage: { classification: "BROKEN_IMPL" },
    });
    expect(action.type).toBe("halt");
    if (action.type === "halt") {
      expect(action.reason).toBe("needs_human");
      expect(action.detail).toMatch(/G3/);
      expect(action.detail).toMatch(/F-001/);
    }
  });

  test("triage=MISSING_ASSERTION → screwdriver (re-validate after contract append)", () => {
    const action = nextAction({
      state: makeState({
        phase: "executing",
        current_milestone: "M-001",
        current_feature: "F-001",
        current_step: "steward_triage",
      }),
      contract: makeContract(),
      lastTriage: { classification: "MISSING_ASSERTION" },
    });
    expect(action.type).toBe("screwdriver");
  });

  test("triage step but lastTriage missing → halt(needs_human)", () => {
    const action = nextAction({
      state: makeState({
        phase: "executing",
        current_milestone: "M-001",
        current_feature: "F-001",
        current_step: "steward_triage",
      }),
      contract: makeContract(),
    });
    expect(action.type).toBe("halt");
  });
});

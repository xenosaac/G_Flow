import { describe, test, expect } from "bun:test";
import {
  Contract,
  Feature,
  Milestone,
  Assertion,
  type ContractT,
} from "../src/artifacts/contract.ts";
import { Handoff, CommandRun } from "../src/artifacts/handoff.ts";
import { ValidatorReport, AssertionResult, Decision } from "../src/artifacts/reports.ts";
import { FlowState } from "../src/artifacts/state.ts";

const sampleAssertion = {
  id: "A-001-001",
  text: "POST /api/auth/signup returns 201 with {token}",
  validator: "screwdriver" as const,
  evidence_required: "HTTP response capture",
};

const sampleFeature = {
  id: "F-001",
  title: "Signup endpoint",
  spec: "Implement POST /api/auth/signup",
  assertions: [sampleAssertion],
};

const sampleMilestone = {
  id: "M-001",
  title: "Auth works end-to-end",
  endpoint_criteria: "User can sign up, log out, log back in",
  features: [sampleFeature],
};

const sampleContract = {
  flow_id: "f_2026_05_16_0001",
  goal: "build a todo app",
  created_at: "2026-05-16T10:00:00.000Z",
  milestones: [sampleMilestone],
};

describe("contract schema", () => {
  test("parses a valid contract", () => {
    const parsed = Contract.parse(sampleContract);
    expect(parsed.milestones[0]!.features[0]!.assertions[0]!.status).toBe("pending");
    expect(parsed.milestones[0]!.features[0]!.assertions[0]!.origin).toBe("original");
    expect(parsed.milestones[0]!.features[0]!.assertions[0]!.attempts).toEqual([]);
  });

  test("rejects empty milestones", () => {
    expect(() =>
      Contract.parse({ ...sampleContract, milestones: [] }),
    ).toThrow();
  });

  test("rejects feature with no assertions", () => {
    expect(() =>
      Feature.parse({ ...sampleFeature, assertions: [] }),
    ).toThrow();
  });

  test("rejects assertion with empty evidence_required", () => {
    expect(() =>
      Assertion.parse({ ...sampleAssertion, evidence_required: "" }),
    ).toThrow();
  });

  test("rejects invalid validator value", () => {
    expect(() =>
      Assertion.parse({ ...sampleAssertion, validator: "playwright" as never }),
    ).toThrow();
  });

  test("rejects milestone with no features", () => {
    expect(() =>
      Milestone.parse({ ...sampleMilestone, features: [] }),
    ).toThrow();
  });

  test("round-trips through JSON.stringify", () => {
    const parsed = Contract.parse(sampleContract);
    const reparsed = Contract.parse(JSON.parse(JSON.stringify(parsed))) as ContractT;
    expect(reparsed).toEqual(parsed);
  });
});

describe("handoff schema", () => {
  test("parses a valid handoff", () => {
    const h = Handoff.parse({
      feature_id: "F-001",
      flow_id: "f_2026_05_16_0001",
      completed: true,
      files_touched: ["src/api/signup.ts"],
      commands_run: [{ cmd: "bun test", exit_code: 0 }],
      assertions_attempted: ["A-001-001"],
      recorded_at: "2026-05-16T11:00:00.000Z",
    });
    expect(h.deviations).toBe("");
    expect(h.next_worker_hints).toBe("");
    expect(h.commands_run[0]!.stdout_tail).toBe("");
  });

  test("CommandRun allows null exit_code (timed-out / killed)", () => {
    const c = CommandRun.parse({ cmd: "bun run dev", exit_code: null });
    expect(c.exit_code).toBeNull();
  });

  test("rejects empty cmd", () => {
    expect(() => CommandRun.parse({ cmd: "", exit_code: 0 })).toThrow();
  });
});

describe("reports schema", () => {
  test("ValidatorReport defaults steward_hint to NONE", () => {
    const r = ValidatorReport.parse({
      feature_id: "F-001",
      flow_id: "f_2026_05_16_0001",
      validator: "screwdriver",
      status: "pass",
      recorded_at: "2026-05-16T11:30:00.000Z",
    });
    expect(r.steward_hint).toBe("NONE");
    expect(r.assertion_results).toEqual([]);
  });

  test("tool_error report carries INFRA hint", () => {
    const r = ValidatorReport.parse({
      feature_id: "F-001",
      flow_id: "f_2026_05_16_0001",
      validator: "user-test",
      status: "tool_error",
      raw_stderr_tail: "OPENAI_API_KEY missing",
      recorded_at: "2026-05-16T11:30:00.000Z",
      steward_hint: "INFRA",
    });
    expect(r.steward_hint).toBe("INFRA");
    expect(r.status).toBe("tool_error");
  });

  test("AssertionResult requires assertion_id", () => {
    expect(() =>
      AssertionResult.parse({ outcome: "pass" } as never),
    ).toThrow();
  });

  test("Decision schema parses outcome enum", () => {
    const d = Decision.parse({
      feature_id: "F-001",
      flow_id: "f_2026_05_16_0001",
      outcome: "passing",
      recorded_at: "2026-05-16T12:00:00.000Z",
      attempt: 1,
    });
    expect(d.outcome).toBe("passing");
    expect(d.backlinks).toEqual([]);
  });
});

describe("FlowState schema", () => {
  test("parses a minimal state", () => {
    const s = FlowState.parse({
      flow_id: "f_2026_05_16_0001",
      phase: "planning",
      current_milestone: null,
      current_feature: null,
      current_step: null,
      counters: {},
      started_at: "2026-05-16T10:00:00.000Z",
      updated_at: "2026-05-16T10:00:00.000Z",
    });
    expect(s.phase).toBe("planning");
    expect(s.corrective_attempts).toEqual({});
    expect(s.counters.llm_calls).toBe(0);
  });

  test("rejects invalid phase", () => {
    expect(() =>
      FlowState.parse({
        flow_id: "f",
        phase: "frobnicated",
        current_milestone: null,
        current_feature: null,
        current_step: null,
        counters: {},
        started_at: "x",
        updated_at: "x",
      } as never),
    ).toThrow();
  });

  test("rejects negative counters", () => {
    expect(() =>
      FlowState.parse({
        flow_id: "f",
        phase: "planning",
        current_milestone: null,
        current_feature: null,
        current_step: null,
        counters: { llm_calls: -1 },
        started_at: "x",
        updated_at: "x",
      }),
    ).toThrow();
  });
});

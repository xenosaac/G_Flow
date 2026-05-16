import type { FlowStateT, FlowStepT } from "../artifacts/state.ts";
import type {
  ContractT,
  FeatureT,
  MilestoneT,
  AssertionT,
} from "../artifacts/contract.ts";
import type {
  ValidatorReportT,
  AssertionResultT,
  TriageClassificationT,
} from "../artifacts/reports.ts";

/** G3: max corrective Worker attempts per feature before halting to needs_human. */
export const CORRECTIVE_CAP = 5;

export type Action =
  | {
      type: "worker";
      feature: FeatureT;
      milestone_id: string;
      mode: "original";
      attempt: number;
    }
  | {
      type: "corrective_worker";
      feature: FeatureT;
      milestone_id: string;
      failures: AssertionResultT[];
      attempt: number;
    }
  | { type: "screwdriver"; feature: FeatureT; milestone_id: string }
  | { type: "usertest"; feature: FeatureT; milestone_id: string }
  | {
      type: "steward_encode";
      feature: FeatureT;
      milestone_id: string;
      outcome: "passing" | "failing";
      attempt: number;
      failures: AssertionResultT[];
    }
  | {
      type: "steward_triage";
      feature: FeatureT;
      milestone_id: string;
      failures: AssertionResultT[];
      hint?: "INFRA";
    }
  | {
      type: "advance";
      from: { milestone_id: string; feature_id: string };
      to: { milestone_id: string; feature_id: string };
    }
  | { type: "complete" }
  | {
      type: "halt";
      reason: "needs_human" | "awaiting_approval";
      detail: string;
    };

export interface NextActionInput {
  state: FlowStateT;
  contract: ContractT;
  lastScrewdriver?: ValidatorReportT | null;
  lastUserTest?: ValidatorReportT | null;
  lastTriage?: { classification: TriageClassificationT } | null;
}

/**
 * Pure decision function. Given the current state + the most recent artifacts
 * for the current feature, return the next Action. No I/O.
 *
 * Order of precedence:
 *  1. terminal phases (complete / needs_human / planning)
 *  2. cold-start (no current feature) → run Worker on first feature
 *  3. step-based dispatch using state.current_step
 *  4. G2 (usertest tool_error → INFRA triage)
 *  5. G3 (corrective_attempts ≥ CORRECTIVE_CAP → halt needs_human)
 *  6. triage classification routes corrective / MISSING_ASSERTION / INFRA
 */
export function nextAction(input: NextActionInput): Action {
  const { state, contract } = input;

  if (state.phase === "complete") return { type: "complete" };
  if (state.phase === "needs_human") {
    return {
      type: "halt",
      reason: "needs_human",
      detail: "state.phase=needs_human",
    };
  }
  if (state.phase === "planning") {
    return {
      type: "halt",
      reason: "awaiting_approval",
      detail: "contract awaits user approval; run `gflow resume`",
    };
  }

  // executing
  const ctx = findFeatureCtx(state, contract);
  if (!ctx) {
    const first = pickFirst(contract);
    if (!first) return { type: "complete" };
    return {
      type: "worker",
      feature: first.feature,
      milestone_id: first.milestone.id,
      mode: "original",
      attempt: 1,
    };
  }
  const { milestone, feature } = ctx;
  const step: FlowStepT | null = state.current_step;
  const corrective = state.corrective_attempts[feature.id] ?? 0;

  if (step === null) {
    return {
      type: "worker",
      feature,
      milestone_id: milestone.id,
      mode: "original",
      attempt: 1,
    };
  }

  if (step === "worker") {
    return { type: "screwdriver", feature, milestone_id: milestone.id };
  }

  if (step === "screwdriver") {
    return { type: "usertest", feature, milestone_id: milestone.id };
  }

  if (step === "usertest") {
    // G2: subprocess tool_error must NOT be treated as an assertion failure
    if (input.lastUserTest?.status === "tool_error") {
      return {
        type: "steward_triage",
        feature,
        milestone_id: milestone.id,
        failures: [],
        hint: "INFRA",
      };
    }
    const failures = collectFailures(input.lastScrewdriver, input.lastUserTest);
    const outcome: "passing" | "failing" =
      failures.length === 0 ? "passing" : "failing";
    return {
      type: "steward_encode",
      feature,
      milestone_id: milestone.id,
      outcome,
      attempt: corrective + 1,
      failures,
    };
  }

  if (step === "steward_encode") {
    const failures = collectFailures(input.lastScrewdriver, input.lastUserTest);
    if (failures.length === 0) {
      const advance = pickNext(state, contract);
      if (!advance) return { type: "complete" };
      return {
        type: "advance",
        from: { milestone_id: milestone.id, feature_id: feature.id },
        to: {
          milestone_id: advance.milestone.id,
          feature_id: advance.feature.id,
        },
      };
    }
    return {
      type: "steward_triage",
      feature,
      milestone_id: milestone.id,
      failures,
    };
  }

  if (step === "steward_triage") {
    if (!input.lastTriage) {
      return {
        type: "halt",
        reason: "needs_human",
        detail: "steward_triage completed without classification",
      };
    }
    switch (input.lastTriage.classification) {
      case "INFRA":
        return {
          type: "halt",
          reason: "needs_human",
          detail: "Steward classified failure as INFRA (tool/env issue)",
        };
      case "BROKEN_IMPL": {
        // G3: cap is on completed corrective attempts; a brand-new
        // corrective attempt would push the counter to corrective+1, so
        // halt when corrective already reached the cap.
        if (corrective >= CORRECTIVE_CAP) {
          return {
            type: "halt",
            reason: "needs_human",
            detail: `G3 cap reached: ${corrective} corrective attempts on ${feature.id}`,
          };
        }
        const failures = collectFailures(
          input.lastScrewdriver,
          input.lastUserTest,
        );
        return {
          type: "corrective_worker",
          feature,
          milestone_id: milestone.id,
          failures,
          attempt: corrective + 1,
        };
      }
      case "MISSING_ASSERTION":
        // Steward appended new assertions to contract → re-validate
        return { type: "screwdriver", feature, milestone_id: milestone.id };
    }
  }

  return {
    type: "halt",
    reason: "needs_human",
    detail: `unhandled step ${step}`,
  };
}

function findFeatureCtx(
  state: FlowStateT,
  contract: ContractT,
): { milestone: MilestoneT; feature: FeatureT } | null {
  if (!state.current_milestone || !state.current_feature) return null;
  const m = contract.milestones.find((x) => x.id === state.current_milestone);
  if (!m) return null;
  const f = m.features.find((x) => x.id === state.current_feature);
  if (!f) return null;
  return { milestone: m, feature: f };
}

function pickFirst(
  contract: ContractT,
): { milestone: MilestoneT; feature: FeatureT } | null {
  const m = contract.milestones[0];
  if (!m) return null;
  const f = m.features[0];
  if (!f) return null;
  return { milestone: m, feature: f };
}

function pickNext(
  state: FlowStateT,
  contract: ContractT,
): { milestone: MilestoneT; feature: FeatureT } | null {
  let foundCurrent = false;
  for (const m of contract.milestones) {
    for (const f of m.features) {
      if (foundCurrent) return { milestone: m, feature: f };
      if (m.id === state.current_milestone && f.id === state.current_feature) {
        foundCurrent = true;
      }
    }
  }
  return null;
}

function collectFailures(
  scr?: ValidatorReportT | null,
  ut?: ValidatorReportT | null,
): AssertionResultT[] {
  const out: AssertionResultT[] = [];
  for (const r of [scr, ut]) {
    if (!r) continue;
    for (const ar of r.assertion_results) {
      if (ar.outcome === "fail") out.push(ar);
    }
  }
  return out;
}

/** Helper: count features for status display. */
export function countFeatures(contract: ContractT): number {
  return contract.milestones.reduce((s, m) => s + m.features.length, 0);
}

/** Helper: count assertions across the whole contract. */
export function countAssertions(contract: ContractT): number {
  return contract.milestones.reduce(
    (s, m) => s + m.features.reduce((t, f) => t + f.assertions.length, 0),
    0,
  );
}

/** Helper: enumerate every assertion for a given feature_id. */
export function findFeatureById(
  contract: ContractT,
  feature_id: string,
): { milestone: MilestoneT; feature: FeatureT } | null {
  for (const m of contract.milestones) {
    for (const f of m.features) {
      if (f.id === feature_id) return { milestone: m, feature: f };
    }
  }
  return null;
}

export type { FeatureT, MilestoneT, AssertionT };

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { ContractT } from "../artifacts/contract.ts";

let cachedVersion: string | null = null;

export function gflowVersion(): string {
  if (cachedVersion !== null) return cachedVersion;
  try {
    const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    cachedVersion = String(pkg.version ?? "0.0.0");
  } catch {
    cachedVersion = "0.0.0";
  }
  return cachedVersion;
}

export function __resetCachedVersion(v?: string): void {
  cachedVersion = v ?? null;
}

export const GbrainKindV2 = z.enum([
  "plan_created",
  "feature_close",
  "milestone_close",
  "flow_complete",
  "worker_handoff",
  "validator_report",
  "steward_decision",
  "steward_triage",
]);
export type GbrainKindV2T = z.infer<typeof GbrainKindV2>;

export const SnapshotPhase = z.enum([
  "clarifying",
  "planning",
  "executing",
  "paused",
  "needs_human",
  "complete",
]);
export type SnapshotPhaseT = z.infer<typeof SnapshotPhase>;

export const ContractSummary = z.object({
  milestone_count: z.number().int().nonnegative(),
  feature_count: z.number().int().nonnegative(),
  assertion_count: z.number().int().nonnegative(),
});
export type ContractSummaryT = z.infer<typeof ContractSummary>;

export const HandoffCommand = z.object({
  cmd: z.string(),
  exit_code: z.number().nullable(),
});
export type HandoffCommandT = z.infer<typeof HandoffCommand>;

export const HandoffSummary = z.object({
  files_touched: z.array(z.string()).default([]),
  commands_run: z.array(HandoffCommand).default([]),
  deviations: z.string().default(""),
  next_worker_hints: z.string().default(""),
});
export type HandoffSummaryT = z.infer<typeof HandoffSummary>;

export const AssertionOutcome = z.object({
  id: z.string(),
  outcome: z.string(),
});
export type AssertionOutcomeT = z.infer<typeof AssertionOutcome>;

export const ValidatorOutcomeSummary = z.object({
  status: z.enum(["pass", "fail", "tool_error"]),
  assertion_outcomes: z.array(AssertionOutcome).default([]),
  steward_hint: z.enum(["INFRA", "BROKEN_IMPL", "MISSING_ASSERTION", "NONE"]).default("NONE"),
});
export type ValidatorOutcomeSummaryT = z.infer<typeof ValidatorOutcomeSummary>;

export const TriageSummary = z.object({
  classification: z.enum(["BROKEN_IMPL", "MISSING_ASSERTION", "INFRA"]),
  rationale: z.string().default(""),
  new_assertions_count: z.number().int().nonnegative().default(0),
});
export type TriageSummaryT = z.infer<typeof TriageSummary>;

export const StewardDecisionSummary = z.object({
  outcome: z.enum(["passing", "failing", "needs_human"]),
  attempt: z.number().int().min(1),
  body_md_excerpt: z.string().default(""),
});
export type StewardDecisionSummaryT = z.infer<typeof StewardDecisionSummary>;

export const GbrainPayloadV2 = z.object({
  goal: z.string().optional(),
  phase: SnapshotPhase,
  milestone_id: z.string().nullable().optional(),
  feature_id: z.string().nullable().optional(),
  feature_title: z.string().optional(),
  assertion_ids: z.array(z.string()).default([]),
  contract_summary: ContractSummary.optional(),
  contract_hash: z.string().optional(),
  target_dir: z.string().optional(),
  target_url: z.string().optional(),
  handoff: HandoffSummary.optional(),
  screwdriver: ValidatorOutcomeSummary.optional(),
  user_test: ValidatorOutcomeSummary.optional(),
  triage: TriageSummary.optional(),
  steward_decision: StewardDecisionSummary.optional(),
  artifact_paths: z.array(z.string()).default([]),
});
export type GbrainPayloadV2T = z.infer<typeof GbrainPayloadV2>;

export const GbrainSnapshotV2 = z.object({
  schema_version: z.literal(2),
  flow_id: z.string().min(1),
  kind: GbrainKindV2,
  recorded_at: z.string(),
  gflow_version: z.string(),
  source_id: z.string().min(1),
  payload: GbrainPayloadV2,
});
export type GbrainSnapshotV2T = z.infer<typeof GbrainSnapshotV2>;

export function hashContract(contract: ContractT): string {
  return createHash("sha256").update(canonicalJson(contract)).digest("hex").slice(0, 16);
}

export function summarizeContract(contract: ContractT): ContractSummaryT {
  let features = 0;
  let assertions = 0;
  for (const m of contract.milestones) {
    features += m.features.length;
    for (const f of m.features) assertions += f.assertions.length;
  }
  return {
    milestone_count: contract.milestones.length,
    feature_count: features,
    assertion_count: assertions,
  };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return (
    "{" +
    keys
      .map((k) => JSON.stringify(k) + ":" + canonicalJson((value as Record<string, unknown>)[k]))
      .join(",") +
    "}"
  );
}

interface BuildBaseInput {
  flow_id: string;
  source_id: string;
  recorded_at?: string;
}

function base(
  input: BuildBaseInput,
  kind: GbrainKindV2T,
  payload: GbrainPayloadV2T,
): GbrainSnapshotV2T {
  return {
    schema_version: 2,
    flow_id: input.flow_id,
    kind,
    recorded_at: input.recorded_at ?? new Date().toISOString(),
    gflow_version: gflowVersion(),
    source_id: input.source_id,
    payload,
  };
}

export function buildPlanCreated(
  input: BuildBaseInput & {
    goal: string;
    contract: ContractT;
    target_dir?: string;
    target_url?: string;
  },
): GbrainSnapshotV2T {
  return base(input, "plan_created", {
    goal: input.goal,
    phase: "planning",
    contract_summary: summarizeContract(input.contract),
    contract_hash: hashContract(input.contract),
    target_dir: input.target_dir,
    target_url: input.target_url,
    assertion_ids: [],
    artifact_paths: ["contract.yaml"],
  });
}

export function buildFeatureClose(
  input: BuildBaseInput & {
    contract: ContractT;
    goal?: string;
    feature_id: string;
    milestone_id: string;
    feature_title?: string;
    assertion_ids?: string[];
    handoff?: HandoffSummaryT;
    screwdriver?: ValidatorOutcomeSummaryT;
    user_test?: ValidatorOutcomeSummaryT;
    target_dir?: string;
    target_url?: string;
    artifact_paths?: string[];
  },
): GbrainSnapshotV2T {
  return base(input, "feature_close", {
    goal: input.goal,
    phase: "executing",
    milestone_id: input.milestone_id,
    feature_id: input.feature_id,
    feature_title: input.feature_title,
    assertion_ids: input.assertion_ids ?? [],
    contract_summary: summarizeContract(input.contract),
    contract_hash: hashContract(input.contract),
    handoff: input.handoff,
    screwdriver: input.screwdriver,
    user_test: input.user_test,
    target_dir: input.target_dir,
    target_url: input.target_url,
    artifact_paths: input.artifact_paths ?? [],
  });
}

export function buildMilestoneClose(
  input: BuildBaseInput & {
    contract: ContractT;
    goal?: string;
    milestone_id: string;
    target_dir?: string;
    target_url?: string;
  },
): GbrainSnapshotV2T {
  return base(input, "milestone_close", {
    goal: input.goal,
    phase: "executing",
    milestone_id: input.milestone_id,
    contract_summary: summarizeContract(input.contract),
    contract_hash: hashContract(input.contract),
    target_dir: input.target_dir,
    target_url: input.target_url,
    assertion_ids: [],
    artifact_paths: [],
  });
}

export function buildFlowComplete(
  input: BuildBaseInput & {
    contract: ContractT;
    goal?: string;
    target_dir?: string;
    target_url?: string;
  },
): GbrainSnapshotV2T {
  return base(input, "flow_complete", {
    goal: input.goal,
    phase: "complete",
    contract_summary: summarizeContract(input.contract),
    contract_hash: hashContract(input.contract),
    target_dir: input.target_dir,
    target_url: input.target_url,
    assertion_ids: [],
    artifact_paths: [],
  });
}

export function buildWorkerHandoff(
  input: BuildBaseInput & {
    contract: ContractT;
    goal?: string;
    feature_id: string;
    milestone_id: string;
    feature_title?: string;
    handoff: HandoffSummaryT;
    target_dir?: string;
  },
): GbrainSnapshotV2T {
  return base(input, "worker_handoff", {
    goal: input.goal,
    phase: "executing",
    milestone_id: input.milestone_id,
    feature_id: input.feature_id,
    feature_title: input.feature_title,
    handoff: input.handoff,
    contract_summary: summarizeContract(input.contract),
    contract_hash: hashContract(input.contract),
    target_dir: input.target_dir,
    assertion_ids: [],
    artifact_paths: [],
  });
}

export function buildValidatorReport(
  input: BuildBaseInput & {
    contract: ContractT;
    feature_id: string;
    milestone_id: string;
    feature_title?: string;
    validator: "screwdriver" | "user-test";
    outcome: ValidatorOutcomeSummaryT;
  },
): GbrainSnapshotV2T {
  const payload: GbrainPayloadV2T = {
    phase: "executing",
    milestone_id: input.milestone_id,
    feature_id: input.feature_id,
    feature_title: input.feature_title,
    contract_summary: summarizeContract(input.contract),
    contract_hash: hashContract(input.contract),
    assertion_ids: input.outcome.assertion_outcomes.map((o) => o.id),
    artifact_paths: [],
  };
  if (input.validator === "screwdriver") payload.screwdriver = input.outcome;
  else payload.user_test = input.outcome;
  return base(input, "validator_report", payload);
}

export function buildStewardDecision(
  input: BuildBaseInput & {
    contract: ContractT;
    feature_id: string;
    milestone_id?: string;
    decision: StewardDecisionSummaryT;
  },
): GbrainSnapshotV2T {
  return base(input, "steward_decision", {
    phase: "executing",
    feature_id: input.feature_id,
    milestone_id: input.milestone_id,
    contract_summary: summarizeContract(input.contract),
    contract_hash: hashContract(input.contract),
    steward_decision: input.decision,
    assertion_ids: [],
    artifact_paths: [],
  });
}

export function buildStewardTriage(
  input: BuildBaseInput & {
    contract: ContractT;
    feature_id: string;
    milestone_id?: string;
    triage: TriageSummaryT;
  },
): GbrainSnapshotV2T {
  return base(input, "steward_triage", {
    phase: "executing",
    feature_id: input.feature_id,
    milestone_id: input.milestone_id,
    contract_summary: summarizeContract(input.contract),
    contract_hash: hashContract(input.contract),
    triage: input.triage,
    assertion_ids: [],
    artifact_paths: [],
  });
}

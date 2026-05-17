import { enqueueSnapshot } from "./client.ts";
import {
  buildPlanCreated,
  buildFeatureClose,
  buildMilestoneClose,
  buildFlowComplete,
  buildWorkerHandoff,
  buildValidatorReport,
  buildStewardDecision,
  buildStewardTriage,
  type HandoffSummaryT,
  type ValidatorOutcomeSummaryT,
  type TriageSummaryT,
  type StewardDecisionSummaryT,
} from "./snapshot.ts";
import type { ContractT } from "../artifacts/contract.ts";
import type { HandoffT } from "../artifacts/handoff.ts";
import type { ValidatorReportT } from "../artifacts/reports.ts";

function sourceId(): string {
  return (process.env.GBRAIN_SOURCE_ID ?? "").trim() || "gflow";
}

/** Fire-and-forget `plan_created` snapshot — emitted by both CLI and web start/replan paths. */
export function emitPlanCreated(input: {
  flow_id: string;
  goal: string;
  contract: ContractT;
  target_dir?: string;
  target_url?: string;
}): void {
  enqueueSnapshot(
    buildPlanCreated({
      flow_id: input.flow_id,
      source_id: sourceId(),
      goal: input.goal,
      contract: input.contract,
      target_dir: input.target_dir,
      target_url: input.target_url,
    }),
  );
}

export function emitFeatureClose(input: {
  flow_id: string;
  contract: ContractT;
  feature_id: string;
  milestone_id: string;
  feature_title?: string;
  assertion_ids?: string[];
  goal?: string;
  handoff?: HandoffSummaryT;
  screwdriver?: ValidatorOutcomeSummaryT;
  user_test?: ValidatorOutcomeSummaryT;
  target_dir?: string;
  target_url?: string;
  artifact_paths?: string[];
}): void {
  enqueueSnapshot(buildFeatureClose({ ...input, source_id: sourceId() }));
}

export function emitMilestoneClose(input: {
  flow_id: string;
  contract: ContractT;
  milestone_id: string;
  goal?: string;
  target_dir?: string;
  target_url?: string;
}): void {
  enqueueSnapshot(buildMilestoneClose({ ...input, source_id: sourceId() }));
}

export function emitFlowComplete(input: {
  flow_id: string;
  contract: ContractT;
  goal?: string;
  target_dir?: string;
  target_url?: string;
}): void {
  enqueueSnapshot(buildFlowComplete({ ...input, source_id: sourceId() }));
}

export function emitWorkerHandoff(input: {
  flow_id: string;
  contract: ContractT;
  feature_id: string;
  milestone_id: string;
  feature_title?: string;
  handoff: HandoffT;
  target_dir?: string;
  goal?: string;
}): void {
  const summary: HandoffSummaryT = {
    files_touched: input.handoff.files_touched ?? [],
    commands_run: (input.handoff.commands_run ?? []).map((c) => ({
      cmd: c.cmd,
      exit_code: c.exit_code,
    })),
    deviations: input.handoff.deviations ?? "",
    next_worker_hints: input.handoff.next_worker_hints ?? "",
  };
  enqueueSnapshot(
    buildWorkerHandoff({
      flow_id: input.flow_id,
      source_id: sourceId(),
      contract: input.contract,
      feature_id: input.feature_id,
      milestone_id: input.milestone_id,
      feature_title: input.feature_title,
      handoff: summary,
      target_dir: input.target_dir,
      goal: input.goal,
    }),
  );
}

export function emitValidatorReport(input: {
  flow_id: string;
  contract: ContractT;
  feature_id: string;
  milestone_id: string;
  feature_title?: string;
  report: ValidatorReportT;
}): void {
  const validator: "screwdriver" | "user-test" = input.report.validator;
  const outcome: ValidatorOutcomeSummaryT = {
    status: input.report.status,
    assertion_outcomes: input.report.assertion_results.map((r) => ({
      id: r.assertion_id,
      outcome: r.outcome,
    })),
    steward_hint: input.report.steward_hint,
  };
  enqueueSnapshot(
    buildValidatorReport({
      flow_id: input.flow_id,
      source_id: sourceId(),
      contract: input.contract,
      feature_id: input.feature_id,
      milestone_id: input.milestone_id,
      feature_title: input.feature_title,
      validator,
      outcome,
    }),
  );
}

export function emitStewardDecision(input: {
  flow_id: string;
  contract: ContractT;
  feature_id: string;
  milestone_id?: string;
  outcome: "passing" | "failing" | "needs_human";
  attempt: number;
  body_md?: string;
}): void {
  const summary: StewardDecisionSummaryT = {
    outcome: input.outcome,
    attempt: input.attempt,
    body_md_excerpt: (input.body_md ?? "").slice(0, 600),
  };
  enqueueSnapshot(
    buildStewardDecision({
      flow_id: input.flow_id,
      source_id: sourceId(),
      contract: input.contract,
      feature_id: input.feature_id,
      milestone_id: input.milestone_id,
      decision: summary,
    }),
  );
}

export function emitStewardTriage(input: {
  flow_id: string;
  contract: ContractT;
  feature_id: string;
  milestone_id?: string;
  classification: "BROKEN_IMPL" | "MISSING_ASSERTION" | "INFRA";
  rationale?: string;
  new_assertions_count?: number;
}): void {
  const triage: TriageSummaryT = {
    classification: input.classification,
    rationale: input.rationale ?? "",
    new_assertions_count: input.new_assertions_count ?? 0,
  };
  enqueueSnapshot(
    buildStewardTriage({
      flow_id: input.flow_id,
      source_id: sourceId(),
      contract: input.contract,
      feature_id: input.feature_id,
      milestone_id: input.milestone_id,
      triage,
    }),
  );
}

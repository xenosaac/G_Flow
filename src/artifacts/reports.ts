import { z } from "zod";
import { ValidatorKind, AttemptOutcome } from "./contract.ts";

export const ReportStatus = z.enum(["pass", "fail", "tool_error"]);
export type ReportStatusT = z.infer<typeof ReportStatus>;

export const StewardHint = z.enum(["INFRA", "BROKEN_IMPL", "MISSING_ASSERTION", "NONE"]);
export type StewardHintT = z.infer<typeof StewardHint>;

export const AssertionResult = z.object({
  assertion_id: z.string().min(1),
  outcome: AttemptOutcome,
  detail: z.string().default(""),
  evidence: z.string().optional(),
});
export type AssertionResultT = z.infer<typeof AssertionResult>;

export const ValidatorReport = z.object({
  feature_id: z.string().min(1),
  flow_id: z.string().min(1),
  validator: ValidatorKind,
  status: ReportStatus,
  assertion_results: z.array(AssertionResult).default([]),
  raw_stdout_tail: z.string().default(""),
  raw_stderr_tail: z.string().default(""),
  recorded_at: z.string(),
  steward_hint: StewardHint.default("NONE"),
});
export type ValidatorReportT = z.infer<typeof ValidatorReport>;

export const TriageClassification = z.enum(["BROKEN_IMPL", "MISSING_ASSERTION", "INFRA"]);
export type TriageClassificationT = z.infer<typeof TriageClassification>;

export const Decision = z.object({
  feature_id: z.string().min(1),
  flow_id: z.string().min(1),
  outcome: z.enum(["passing", "failing", "needs_human"]),
  recorded_at: z.string(),
  backlinks: z.array(z.string()).default([]),
  attempt: z.number().int().min(1),
  body_md: z.string().default(""),
});
export type DecisionT = z.infer<typeof Decision>;

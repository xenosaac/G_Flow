import { z } from "zod";

export const ValidatorKind = z.enum(["screwdriver", "user-test"]);
export type ValidatorKindT = z.infer<typeof ValidatorKind>;

export const AssertionStatus = z.enum(["pending", "passing", "failing", "needs_human"]);
export type AssertionStatusT = z.infer<typeof AssertionStatus>;

export const AssertionOrigin = z.enum(["original", "corrective"]);
export type AssertionOriginT = z.infer<typeof AssertionOrigin>;

export const AttemptOutcome = z.enum(["pass", "fail", "tool_error"]);
export type AttemptOutcomeT = z.infer<typeof AttemptOutcome>;

export const AssertionAttempt = z.object({
  attempt_number: z.number().int().min(1),
  recorded_at: z.string(),
  outcome: AttemptOutcome,
  evidence: z.string().optional(),
  detail: z.string().optional(),
});
export type AssertionAttemptT = z.infer<typeof AssertionAttempt>;

export const FileExistsCheck = z.object({
  kind: z.literal("file_exists"),
  path: z.string().min(1),
});
export type FileExistsCheckT = z.infer<typeof FileExistsCheck>;

export const FileContainsCheck = z.object({
  kind: z.literal("file_contains"),
  path: z.string().min(1),
  substring: z.string().min(1),
});
export type FileContainsCheckT = z.infer<typeof FileContainsCheck>;

export const CommandCheck = z.object({
  kind: z.literal("command"),
  cmd: z.array(z.string().min(1)).min(1),
  expected_exit_code: z.number().int().optional(),
  stdout_includes: z.string().min(1).optional(),
  timeout_ms: z.number().int().positive().optional(),
});
export type CommandCheckT = z.infer<typeof CommandCheck>;

/**
 * Per-assertion mechanical check for Screwdriver. Optional — when absent,
 * Screwdriver falls back to legacy project-wide `bun test` + `tsc --noEmit`
 * (skipped when the project has no test script / tsconfig).
 */
export const AssertionCheck = z.discriminatedUnion("kind", [
  FileExistsCheck,
  FileContainsCheck,
  CommandCheck,
]);
export type AssertionCheckT = z.infer<typeof AssertionCheck>;

export const Assertion = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  validator: ValidatorKind,
  evidence_required: z.string().min(1),
  status: AssertionStatus.default("pending"),
  origin: AssertionOrigin.default("original"),
  attempts: z.array(AssertionAttempt).default([]),
  check: AssertionCheck.optional(),
});
export type AssertionT = z.infer<typeof Assertion>;

export const Feature = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  spec: z.string().min(1),
  assertions: z.array(Assertion).min(1),
});
export type FeatureT = z.infer<typeof Feature>;

export const Milestone = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  endpoint_criteria: z.string().min(1),
  features: z.array(Feature).min(1),
});
export type MilestoneT = z.infer<typeof Milestone>;

export const Contract = z.object({
  flow_id: z.string().min(1),
  goal: z.string().min(1),
  created_at: z.string(),
  approved_at: z.string().optional(),
  milestones: z.array(Milestone).min(1),
});
export type ContractT = z.infer<typeof Contract>;

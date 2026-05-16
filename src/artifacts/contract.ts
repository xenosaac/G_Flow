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

export const Assertion = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  validator: ValidatorKind,
  evidence_required: z.string().min(1),
  status: AssertionStatus.default("pending"),
  origin: AssertionOrigin.default("original"),
  attempts: z.array(AssertionAttempt).default([]),
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

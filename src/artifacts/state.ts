import { z } from "zod";

export const FlowPhase = z.enum([
  "clarifying",
  "planning",
  "executing",
  "paused",
  "needs_human",
  "complete",
]);
export type FlowPhaseT = z.infer<typeof FlowPhase>;

export const FlowStep = z.enum([
  "worker",
  "screwdriver",
  "usertest",
  "steward_encode",
  "steward_triage",
]);
export type FlowStepT = z.infer<typeof FlowStep>;

export const FlowCounters = z.object({
  llm_calls: z.number().int().nonnegative().default(0),
  tokens_in: z.number().int().nonnegative().default(0),
  tokens_out: z.number().int().nonnegative().default(0),
  usd_spent: z.number().nonnegative().default(0),
});
export type FlowCountersT = z.infer<typeof FlowCounters>;

export const FlowState = z.object({
  flow_id: z.string().min(1),
  phase: FlowPhase,
  current_milestone: z.string().nullable(),
  current_feature: z.string().nullable(),
  current_step: FlowStep.nullable(),
  corrective_attempts: z.record(z.string(), z.number().int().nonnegative()).default({}),
  counters: FlowCounters,
  started_at: z.string(),
  updated_at: z.string(),
});
export type FlowStateT = z.infer<typeof FlowState>;

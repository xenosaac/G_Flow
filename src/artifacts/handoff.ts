import { z } from "zod";

export const CommandRun = z.object({
  cmd: z.string().min(1),
  exit_code: z.number().int().nullable(),
  stdout_tail: z.string().default(""),
  stderr_tail: z.string().default(""),
  note: z.string().optional(),
});
export type CommandRunT = z.infer<typeof CommandRun>;

export const Handoff = z.object({
  feature_id: z.string().min(1),
  flow_id: z.string().min(1),
  completed: z.boolean(),
  files_touched: z.array(z.string()).default([]),
  commands_run: z.array(CommandRun).default([]),
  assertions_attempted: z.array(z.string()).default([]),
  deviations: z.string().default(""),
  next_worker_hints: z.string().default(""),
  recorded_at: z.string(),
});
export type HandoffT = z.infer<typeof Handoff>;

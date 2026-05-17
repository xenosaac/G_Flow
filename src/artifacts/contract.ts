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

export const BrowserGotoStep = z.object({
  kind: z.literal("goto"),
  path: z.string().min(1),
});
export const BrowserFillStep = z.object({
  kind: z.literal("fill"),
  selector: z.string().min(1),
  value: z.string(),
});
export const BrowserClickStep = z.object({
  kind: z.literal("click"),
  selector: z.string().min(1),
});
export const BrowserPressStep = z.object({
  kind: z.literal("press"),
  selector: z.string().min(1),
  key: z.string().min(1),
});
export const BrowserExpectTextStep = z.object({
  kind: z.literal("expect_text"),
  selector: z.string().min(1),
  text: z.string(),
});
export const BrowserExpectValueStep = z.object({
  kind: z.literal("expect_value"),
  selector: z.string().min(1),
  value: z.string(),
});
export const BrowserExpectUrlStep = z.object({
  kind: z.literal("expect_url"),
  contains: z.string().min(1),
});
export const BrowserExpectCountStep = z.object({
  kind: z.literal("expect_count"),
  selector: z.string().min(1),
  count: z.number().int().nonnegative(),
});

export const BrowserStep = z.discriminatedUnion("kind", [
  BrowserGotoStep,
  BrowserFillStep,
  BrowserClickStep,
  BrowserPressStep,
  BrowserExpectTextStep,
  BrowserExpectValueStep,
  BrowserExpectUrlStep,
  BrowserExpectCountStep,
]);
export type BrowserStepT = z.infer<typeof BrowserStep>;

export const UserCheck = z
  .object({
    kind: z.literal("browser_flow"),
    start: z.enum(["target_url", "file"]),
    path: z.string().min(1).optional(),
    steps: z.array(BrowserStep).min(1),
    timeout_ms: z.number().int().positive().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.start === "file") {
      if (!value.path) {
        ctx.addIssue({
          code: "custom",
          path: ["path"],
          message: "path is required when start=file",
        });
      } else if (!isSafeRelativePath(value.path)) {
        ctx.addIssue({
          code: "custom",
          path: ["path"],
          message: "file path must be relative to target_dir and must not contain '..'",
        });
      }
    }
    for (const [idx, step] of value.steps.entries()) {
      if (step.kind === "goto" && !isSafeRelativeRoute(step.path)) {
        ctx.addIssue({
          code: "custom",
          path: ["steps", idx, "path"],
          message: "goto.path must be relative to target_url and must not navigate externally",
        });
      }
    }
  });
export type UserCheckT = z.infer<typeof UserCheck>;

const AssertionBase = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  validator: ValidatorKind,
  evidence_required: z.string().min(1),
  status: AssertionStatus.default("pending"),
  origin: AssertionOrigin.default("original"),
  attempts: z.array(AssertionAttempt).default([]),
  check: AssertionCheck.optional(),
  user_check: UserCheck.optional(),
});

export const Assertion = AssertionBase.superRefine((value, ctx) => {
  if (value.validator === "screwdriver") {
    if (!value.check) {
      ctx.addIssue({
        code: "custom",
        path: ["check"],
        message: "screwdriver assertions require check",
      });
    }
    if (value.user_check) {
      ctx.addIssue({
        code: "custom",
        path: ["user_check"],
        message: "screwdriver assertions must not include user_check",
      });
    }
  }
  if (value.validator === "user-test") {
    if (!value.user_check) {
      ctx.addIssue({
        code: "custom",
        path: ["user_check"],
        message: "user-test assertions require user_check",
      });
    }
    if (value.check) {
      ctx.addIssue({
        code: "custom",
        path: ["check"],
        message: "user-test assertions must not include check",
      });
    }
  }
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

export function isSafeRelativePath(path: string): boolean {
  if (!path || path.startsWith("/") || path.startsWith("\\") || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(path)) {
    return false;
  }
  const parts = path.split(/[\\/]+/);
  return !parts.some((part) => part === "..");
}

export function isSafeRelativeRoute(path: string): boolean {
  if (!path || path.startsWith("//") || path.startsWith("\\") || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(path)) {
    return false;
  }
  const parts = path.split(/[\\/]+/);
  return !parts.some((part) => part === "..");
}

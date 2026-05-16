import { writeFile, mkdir, rename } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnPiped } from "../../adapters/spawn.ts";
import type { FeatureT } from "../../artifacts/contract.ts";
import {
  ValidatorReport,
  type ValidatorReportT,
  type AssertionResultT,
} from "../../artifacts/reports.ts";

const USER_TEST_TIMEOUT_MS = 10 * 60 * 1000;

export interface RunUserTestInput {
  flow_id: string;
  feature: FeatureT;
  target_dir: string;
  /** URL the assertions should be exercised against (e.g., http://localhost:3000). */
  target_url: string;
  /** Test hook: shorten timeout. */
  timeoutMs?: number;
  /** Test hook: override the runner. Defaults to the Python subprocess wrapper. */
  runner?: SubprocessRunner;
  /** Test hook: alternate Python interpreter / script path. */
  python?: string;
  script?: string;
}

export interface SubprocessOutcome {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export type SubprocessRunner = (
  spec: UserTestSpec,
  ctx: { python: string; script: string; cwd: string; timeoutMs: number },
) => Promise<SubprocessOutcome>;

export interface UserTestSpec {
  target_url: string;
  assertions: { id: string; text: string; evidence_required: string }[];
}

/**
 * G2 implementation:
 *   exitCode === 0 → parse JSON, mark assertions per result, status = pass/fail
 *   exitCode !== 0 → mark report status="tool_error", steward_hint="INFRA",
 *                    DO NOT mark assertions as failed.
 *   timedOut       → tool_error / INFRA (same lane)
 *   malformed JSON → tool_error / INFRA (we don't fake pass/fail signal)
 */
export async function runUserTest(
  input: RunUserTestInput,
): Promise<ValidatorReportT> {
  const timeoutMs = input.timeoutMs ?? USER_TEST_TIMEOUT_MS;
  const userAssertions = input.feature.assertions.filter(
    (a) => a.validator === "user-test",
  );

  const spec: UserTestSpec = {
    target_url: input.target_url,
    assertions: userAssertions.map((a) => ({
      id: a.id,
      text: a.text,
      evidence_required: a.evidence_required,
    })),
  };

  const python = input.python ?? process.env.GFLOW_PYTHON ?? "python3";
  const script = input.script ?? defaultScriptPath();
  const runner = input.runner ?? defaultSubprocessRunner;

  let outcome: SubprocessOutcome;
  try {
    outcome = await runner(spec, {
      python,
      script,
      cwd: input.target_dir,
      timeoutMs,
    });
  } catch (err) {
    return toolErrorReport(
      input,
      "subprocess spawn threw",
      err instanceof Error ? err.message : String(err),
    );
  }

  if (outcome.timedOut) {
    return toolErrorReport(input, "timed_out", outcome.stderr);
  }

  if (outcome.exitCode !== 0) {
    return toolErrorReport(
      input,
      `nonzero_exit(${outcome.exitCode})`,
      outcome.stderr,
      outcome.stdout,
    );
  }

  // exit 0 → must parse JSON, otherwise still tool_error (we don't conjure pass/fail)
  let parsed: { results: Array<{ assertion_id: string; outcome: string; detail?: string; evidence?: string }> };
  try {
    parsed = JSON.parse(outcome.stdout);
  } catch (err) {
    return toolErrorReport(
      input,
      "stdout_not_json",
      err instanceof Error ? err.message : String(err),
      outcome.stdout,
    );
  }

  if (!parsed || !Array.isArray(parsed.results)) {
    return toolErrorReport(input, "missing_results", outcome.stdout);
  }

  const byId = new Map(parsed.results.map((r) => [r.assertion_id, r]));
  const assertion_results: AssertionResultT[] = userAssertions.map((a) => {
    const r = byId.get(a.id);
    if (!r) {
      return {
        assertion_id: a.id,
        outcome: "fail" as const,
        detail: "user-test runner did not report a result for this assertion",
      };
    }
    const out = normalizeOutcome(r.outcome);
    return {
      assertion_id: a.id,
      outcome: out,
      detail: r.detail ?? "",
      evidence: r.evidence,
    };
  });

  // G2 second-half fix: per-assertion tool_error must escalate the WHOLE
  // report to tool_error, not "fail". A misclassified fail would trigger a
  // corrective Worker against working code.
  const hasToolError = assertion_results.some((r) => r.outcome === "tool_error");
  const anyFail = assertion_results.some((r) => r.outcome === "fail");
  const status: "pass" | "fail" | "tool_error" = hasToolError
    ? "tool_error"
    : anyFail
      ? "fail"
      : "pass";
  return ValidatorReport.parse({
    feature_id: input.feature.id,
    flow_id: input.flow_id,
    validator: "user-test",
    status,
    assertion_results,
    raw_stdout_tail: tailOf(outcome.stdout, 4000),
    raw_stderr_tail: tailOf(outcome.stderr, 4000),
    recorded_at: new Date().toISOString(),
    steward_hint: hasToolError ? "INFRA" : "NONE",
  });
}

function normalizeOutcome(raw: string): "pass" | "fail" | "tool_error" {
  const v = (raw ?? "").toLowerCase().trim();
  if (v === "pass" || v === "passed" || v === "ok") return "pass";
  if (v === "tool_error" || v === "error") return "tool_error";
  return "fail";
}

function toolErrorReport(
  input: RunUserTestInput,
  reason: string,
  stderr: string,
  stdout = "",
): ValidatorReportT {
  return ValidatorReport.parse({
    feature_id: input.feature.id,
    flow_id: input.flow_id,
    validator: "user-test",
    status: "tool_error",
    assertion_results: [],
    raw_stdout_tail: tailOf(stdout, 4000),
    raw_stderr_tail: tailOf(`G2 tool_error: ${reason}\n${stderr}`, 4000),
    recorded_at: new Date().toISOString(),
    steward_hint: "INFRA",
  });
}

async function defaultSubprocessRunner(
  spec: UserTestSpec,
  ctx: { python: string; script: string; cwd: string; timeoutMs: number },
): Promise<SubprocessOutcome> {
  const r = await spawnPiped([ctx.python, ctx.script], {
    cwd: ctx.cwd,
    timeoutMs: ctx.timeoutMs,
    stdin: JSON.stringify(spec),
  });
  return {
    exitCode: r.exitCode,
    stdout: r.stdout,
    stderr: r.stderr,
    timedOut: r.timedOut,
  };
}

function defaultScriptPath(): string {
  // src/runtime/validators/user-test.ts -> ../../../scripts/user_test_runner.py
  const here = fileURLToPath(import.meta.url);
  return join(here, "..", "..", "..", "..", "scripts", "user_test_runner.py");
}

function tailOf(s: string, n: number): string {
  if (s.length <= n) return s;
  return "…" + s.slice(-n);
}

/** Persist a UserTest report. */
export async function writeUserTestReport(
  report: ValidatorReportT,
  reportsDir: string,
  attempt: number,
): Promise<string> {
  await mkdir(reportsDir, { recursive: true });
  const path = join(
    reportsDir,
    `${report.feature_id}__usertest__attempt-${String(attempt).padStart(2, "0")}.json`,
  );
  await atomicWrite(path, JSON.stringify(report, null, 2) + "\n");
  return path;
}

async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  await writeFile(tmp, content, "utf8");
  await rename(tmp, path);
}

import { writeFile, mkdir, rename, stat } from "node:fs/promises";
import { join, dirname } from "node:path";
import type { FeatureT } from "../../artifacts/contract.ts";
import {
  ValidatorReport,
  type ValidatorReportT,
  type AssertionResultT,
} from "../../artifacts/reports.ts";

const SCREWDRIVER_TIMEOUT_MS = 5 * 60 * 1000;

export interface RunScrewdriverInput {
  flow_id: string;
  feature: FeatureT;
  target_dir: string;
  /** Test hook: override timeout. */
  timeoutMs?: number;
  /** Test hook: inject a fake `runProjectChecks` impl. */
  runner?: ProjectChecker;
}

export interface ProjectCheckResult {
  cmd: string;
  exitCode: number | null;
  stdoutTail: string;
  stderrTail: string;
  timedOut: boolean;
}

export type ProjectChecker = (
  target_dir: string,
  timeoutMs: number,
) => Promise<ProjectCheckResult[]>;

/** Run mechanical checks (test, typecheck) and produce a ValidatorReport. */
export async function runScrewdriver(
  input: RunScrewdriverInput,
): Promise<ValidatorReportT> {
  const timeoutMs = input.timeoutMs ?? SCREWDRIVER_TIMEOUT_MS;
  const runner = input.runner ?? defaultProjectChecks;

  const screwdriverAssertions = input.feature.assertions.filter(
    (a) => a.validator === "screwdriver",
  );

  const checks = await runner(input.target_dir, timeoutMs);
  const allPass = checks.every((c) => c.exitCode === 0 && !c.timedOut);
  const stdoutTail = checks
    .map((c) => `$ ${c.cmd} (exit=${c.exitCode})\n${c.stdoutTail}`)
    .join("\n\n");
  const stderrTail = checks
    .map((c) => `$ ${c.cmd} stderr\n${c.stderrTail}`)
    .filter((s) => s.trim().length > "$  stderr".length)
    .join("\n\n");

  const status = allPass ? "pass" : "fail";
  const results: AssertionResultT[] = screwdriverAssertions.map((a) => ({
    assertion_id: a.id,
    outcome: allPass ? "pass" : "fail",
    detail: allPass
      ? "all project checks passed"
      : `at least one check failed: ${checks
          .filter((c) => c.exitCode !== 0 || c.timedOut)
          .map((c) => `${c.cmd}@${c.exitCode ?? "killed"}`)
          .join(", ")}`,
  }));

  return ValidatorReport.parse({
    feature_id: input.feature.id,
    flow_id: input.flow_id,
    validator: "screwdriver",
    status,
    assertion_results: results,
    raw_stdout_tail: truncate(stdoutTail, 4000),
    raw_stderr_tail: truncate(stderrTail, 4000),
    recorded_at: new Date().toISOString(),
    steward_hint: "NONE",
  });
}

/** Default checker: `bun test` and `bun x tsc --noEmit`, run in `target_dir`. */
async function defaultProjectChecks(
  target_dir: string,
  timeoutMs: number,
): Promise<ProjectCheckResult[]> {
  const exists = await dirExists(target_dir);
  if (!exists) {
    return [
      {
        cmd: `(target_dir missing: ${target_dir})`,
        exitCode: 2,
        stdoutTail: "",
        stderrTail: `screwdriver: target_dir does not exist`,
        timedOut: false,
      },
    ];
  }
  const out: ProjectCheckResult[] = [];
  out.push(await runOne(["bun", "test"], target_dir, timeoutMs));
  out.push(await runOne(["bun", "x", "tsc", "--noEmit"], target_dir, timeoutMs));
  return out;
}

async function runOne(
  argv: string[],
  cwd: string,
  timeoutMs: number,
): Promise<ProjectCheckResult> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    const proc = Bun.spawn(argv, {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      signal: controller.signal,
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    return {
      cmd: argv.join(" "),
      exitCode: timedOut ? null : exitCode,
      stdoutTail: tailOf(stdout, 1200),
      stderrTail: tailOf(stderr, 1200),
      timedOut,
    };
  } catch (err) {
    return {
      cmd: argv.join(" "),
      exitCode: null,
      stdoutTail: "",
      stderrTail: err instanceof Error ? err.message : String(err),
      timedOut,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function dirExists(p: string): Promise<boolean> {
  try {
    const s = await stat(p);
    return s.isDirectory();
  } catch {
    return false;
  }
}

function tailOf(s: string, n: number): string {
  if (s.length <= n) return s;
  return "…" + s.slice(-n);
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}

/** Persist a Screwdriver report under `.gflow/<flow_id>/reports/`. */
export async function writeScrewdriverReport(
  report: ValidatorReportT,
  reportsDir: string,
  attempt: number,
): Promise<string> {
  await mkdir(reportsDir, { recursive: true });
  const path = join(
    reportsDir,
    `${report.feature_id}__screwdriver__attempt-${String(attempt).padStart(2, "0")}.json`,
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

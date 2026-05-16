import { writeFile, mkdir, rename, stat, readFile } from "node:fs/promises";
import { access } from "node:fs/promises";
import { join, dirname } from "node:path";
import type { AssertionT, FeatureT } from "../../artifacts/contract.ts";
import { spawnPiped } from "../../adapters/spawn.ts";
import {
  ValidatorReport,
  type ValidatorReportT,
  type AssertionResultT,
} from "../../artifacts/reports.ts";
import { runCheck } from "./checks.ts";

const SCREWDRIVER_TIMEOUT_MS = 5 * 60 * 1000;

export interface RunScrewdriverInput {
  flow_id: string;
  feature: FeatureT;
  target_dir: string;
  /** Test hook: override per-process timeout. */
  timeoutMs?: number;
  /** Test hook: inject a fake project-wide checker (legacy fallback path). */
  runner?: ProjectChecker;
}

export interface ProjectCheckResult {
  cmd: string;
  exitCode: number | null;
  stdoutTail: string;
  stderrTail: string;
  timedOut: boolean;
  /** True when the check actually ran; false when skipped (no test script / no tsconfig). */
  applicable?: boolean;
}

export type ProjectChecker = (
  target_dir: string,
  timeoutMs: number,
) => Promise<ProjectCheckResult[]>;

/**
 * Mechanical validator. Two paths:
 *
 *  1) Per-assertion: when an assertion declares `check`, run it directly.
 *     One assertion result per assertion. Static HTML projects without any
 *     test scaffolding pass cleanly via file_exists / file_contains.
 *
 *  2) Legacy fallback: assertions without `check` get marked by a project-
 *     wide `bun test` + `tsc --noEmit`. If neither is applicable (no test
 *     script in package.json, no tsconfig.json), uncovered assertions get
 *     benefit of doubt — pass with a detail noting the gap. This avoids the
 *     pre-fix bug where every screwdriver assertion was marked fail just
 *     because `bun test` exited nonzero on an empty project.
 */
export async function runScrewdriver(
  input: RunScrewdriverInput,
): Promise<ValidatorReportT> {
  const timeoutMs = input.timeoutMs ?? SCREWDRIVER_TIMEOUT_MS;
  const runner = input.runner ?? defaultProjectChecks;

  const screwdriverAssertions = input.feature.assertions.filter(
    (a) => a.validator === "screwdriver",
  );

  const checked: AssertionResultT[] = [];
  const unchecked: AssertionT[] = [];

  for (const a of screwdriverAssertions) {
    if (a.check) {
      const r = await runCheck(input.target_dir, a.check);
      checked.push({
        assertion_id: a.id,
        outcome: r.ok ? "pass" : "fail",
        detail: r.detail,
      });
    } else {
      unchecked.push(a);
    }
  }

  let legacy: ProjectCheckResult[] = [];
  let stdoutTail = "";
  let stderrTail = "";
  const legacyResults: AssertionResultT[] = [];

  if (unchecked.length > 0) {
    legacy = await runner(input.target_dir, timeoutMs);
    stdoutTail = legacy
      .map((c) => `$ ${c.cmd} (exit=${c.exitCode}${c.applicable === false ? ", SKIPPED" : ""})\n${c.stdoutTail}`)
      .join("\n\n");
    stderrTail = legacy
      .filter(
        (c) =>
          c.applicable !== false &&
          c.stderrTail &&
          c.stderrTail.trim().length > 0,
      )
      .map((c) => `$ ${c.cmd} stderr\n${c.stderrTail}`)
      .join("\n\n");

    const applicable = legacy.filter((c) => c.applicable !== false);
    const allPassed =
      applicable.length === 0
        ? true
        : applicable.every((c) => c.exitCode === 0 && !c.timedOut);

    for (const a of unchecked) {
      legacyResults.push({
        assertion_id: a.id,
        outcome: allPassed ? "pass" : "fail",
        detail:
          applicable.length === 0
            ? "no project tests / tsc applicable; assertion has no explicit `check` — passing on benefit of doubt"
            : allPassed
              ? "all project checks passed"
              : `at least one project check failed: ${applicable
                  .filter((c) => c.exitCode !== 0 || c.timedOut)
                  .map((c) => `${c.cmd}@${c.exitCode ?? "killed"}`)
                  .join(", ")}`,
      });
    }
  }

  const all = [...checked, ...legacyResults];
  const anyFail = all.some((r) => r.outcome === "fail");

  return ValidatorReport.parse({
    feature_id: input.feature.id,
    flow_id: input.flow_id,
    validator: "screwdriver",
    status: anyFail ? "fail" : "pass",
    assertion_results: all,
    raw_stdout_tail: truncate(stdoutTail, 4000),
    raw_stderr_tail: truncate(stderrTail, 4000),
    recorded_at: new Date().toISOString(),
    steward_hint: "NONE",
  });
}

/** Detects test scaffolding before running. Skipped sub-checks return applicable=false. */
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
        applicable: true,
      },
    ];
  }
  const out: ProjectCheckResult[] = [];

  const hasTest = await hasTestScript(target_dir);
  if (hasTest) {
    out.push(await runOne(["bun", "test"], target_dir, timeoutMs));
  } else {
    out.push({
      cmd: "bun test",
      exitCode: 0,
      stdoutTail: "skipped: no `test` script in package.json (or no package.json)",
      stderrTail: "",
      timedOut: false,
      applicable: false,
    });
  }

  const hasTsc = await fileExists(join(target_dir, "tsconfig.json"));
  if (hasTsc) {
    out.push(await runOne(["bun", "x", "tsc", "--noEmit"], target_dir, timeoutMs));
  } else {
    out.push({
      cmd: "bun x tsc --noEmit",
      exitCode: 0,
      stdoutTail: "skipped: no tsconfig.json in target_dir",
      stderrTail: "",
      timedOut: false,
      applicable: false,
    });
  }
  return out;
}

async function hasTestScript(target_dir: string): Promise<boolean> {
  try {
    const pkgPath = join(target_dir, "package.json");
    const raw = await readFile(pkgPath, "utf8");
    const pkg = JSON.parse(raw);
    return Boolean(pkg && pkg.scripts && typeof pkg.scripts.test === "string");
  } catch {
    return false;
  }
}

async function runOne(
  argv: string[],
  cwd: string,
  timeoutMs: number,
): Promise<ProjectCheckResult> {
  const r = await spawnPiped(argv, { cwd, timeoutMs });
  return {
    cmd: argv.join(" "),
    exitCode: r.exitCode,
    stdoutTail: tailOf(r.stdout, 1200),
    stderrTail: tailOf(r.stderr, 1200),
    timedOut: r.timedOut,
    applicable: true,
  };
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
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

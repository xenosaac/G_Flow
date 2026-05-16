import { readFile, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { AssertionCheckT } from "../../artifacts/contract.ts";

export interface CheckOutcome {
  ok: boolean;
  detail: string;
}

const DEFAULT_CHECK_TIMEOUT_MS = 60_000;

export async function runCheck(
  target_dir: string,
  check: AssertionCheckT,
): Promise<CheckOutcome> {
  switch (check.kind) {
    case "file_exists":
      return runFileExists(target_dir, check.path);
    case "file_contains":
      return runFileContains(target_dir, check.path, check.substring);
    case "command":
      return runCommand(
        target_dir,
        check.cmd,
        check.expected_exit_code ?? 0,
        check.stdout_includes,
        check.timeout_ms ?? DEFAULT_CHECK_TIMEOUT_MS,
      );
  }
}

async function runFileExists(
  target_dir: string,
  p: string,
): Promise<CheckOutcome> {
  const safe = resolveInside(target_dir, p);
  if (!safe) return { ok: false, detail: `path escapes target_dir: ${p}` };
  try {
    await stat(safe);
    return { ok: true, detail: `${p} exists` };
  } catch {
    return { ok: false, detail: `${p} does not exist in ${target_dir}` };
  }
}

async function runFileContains(
  target_dir: string,
  p: string,
  substring: string,
): Promise<CheckOutcome> {
  const safe = resolveInside(target_dir, p);
  if (!safe) return { ok: false, detail: `path escapes target_dir: ${p}` };
  try {
    const content = await readFile(safe, "utf8");
    if (content.includes(substring)) {
      return { ok: true, detail: `${p} contains "${truncate(substring, 60)}"` };
    }
    return {
      ok: false,
      detail: `${p} does NOT contain "${truncate(substring, 60)}"`,
    };
  } catch (err) {
    return {
      ok: false,
      detail: `cannot read ${p}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function runCommand(
  target_dir: string,
  cmd: string[],
  expectedExit: number,
  stdoutIncludes: string | undefined,
  timeoutMs: number,
): Promise<CheckOutcome> {
  if (cmd.length === 0) return { ok: false, detail: "empty cmd array" };
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    const proc = Bun.spawn(cmd, {
      cwd: target_dir,
      stdout: "pipe",
      stderr: "pipe",
      signal: controller.signal,
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    if (timedOut) {
      return {
        ok: false,
        detail: `${cmd.join(" ")} timed out after ${timeoutMs}ms`,
      };
    }
    if (exitCode === expectedExit && (!stdoutIncludes || stdout.includes(stdoutIncludes))) {
      return {
        ok: true,
        detail: stdoutIncludes
          ? `${cmd.join(" ")} → exit=${exitCode}; stdout contains "${truncate(stdoutIncludes, 60)}"`
          : `${cmd.join(" ")} → exit=${exitCode}`,
      };
    }
    if (exitCode === expectedExit && stdoutIncludes && !stdout.includes(stdoutIncludes)) {
      return {
        ok: false,
        detail: `${cmd.join(" ")} → exit=${exitCode}; stdout does NOT contain "${truncate(stdoutIncludes, 60)}"; stdout=${tail(stdout, 200)}; stderr=${tail(stderr, 200)}`,
      };
    }
    return {
      ok: false,
      detail: `${cmd.join(" ")} → exit=${exitCode} (expected ${expectedExit}); stdout=${tail(stdout, 200)}; stderr=${tail(stderr, 200)}`,
    };
  } catch (err) {
    return {
      ok: false,
      detail: `spawn ${cmd.join(" ")} threw: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

function resolveInside(root: string, p: string): string | null {
  if (isAbsolute(p)) return null;
  if (p.includes("\0")) return null;
  const r = resolve(root, p);
  const rel = relative(root, r);
  if (rel.startsWith("..") || isAbsolute(rel)) return null;
  return r;
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}

function tail(s: string, n: number): string {
  if (s.length <= n) return s;
  return "…" + s.slice(-n);
}

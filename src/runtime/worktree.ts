import { access, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { spawnPiped } from "../adapters/spawn.ts";

const GIT_TIMEOUT_MS = 60_000;

export interface WorktreeRef {
  mode: "direct" | "worktree";
  path: string;
  branch?: string;
}

export async function prepareFeatureWorktree(input: {
  flowDir: string;
  targetDir: string;
  flowId: string;
  featureId: string;
  attempt: number;
}): Promise<WorktreeRef> {
  const git = await gitAvailable(input.targetDir);
  if (!git || !(await hasHead(input.targetDir))) {
    return { mode: "direct", path: input.targetDir };
  }

  const path = featureWorktreePath(input.flowDir, input.featureId, input.attempt);
  const branch = featureBranch(input.flowId, input.featureId, input.attempt);
  if (await exists(path)) {
    return { mode: "worktree", path, branch };
  }
  await mkdir(join(input.flowDir, "worktrees"), { recursive: true });
  await gitRun(input.targetDir, [
    "worktree",
    "add",
    "-B",
    branch,
    path,
    "HEAD",
  ]);
  return { mode: "worktree", path, branch };
}

export async function worktreeForAttempt(input: {
  flowDir: string;
  targetDir: string;
  flowId: string;
  featureId: string;
  attempt: number;
}): Promise<WorktreeRef> {
  const path = featureWorktreePath(input.flowDir, input.featureId, input.attempt);
  const branch = featureBranch(input.flowId, input.featureId, input.attempt);
  if (await exists(path)) return { mode: "worktree", path, branch };
  return { mode: "direct", path: input.targetDir };
}

export async function mergePassingWorktree(input: {
  flowDir: string;
  targetDir: string;
  flowId: string;
  featureId: string;
  attempt: number;
}): Promise<void> {
  const ref = await worktreeForAttempt(input);
  if (ref.mode !== "worktree" || !ref.branch) return;
  await commitDirtyWorktree(ref.path, input.featureId, input.attempt);
  await gitRun(input.targetDir, ["merge", "--ff-only", ref.branch]);
}

export function featureWorktreePath(
  flowDir: string,
  featureId: string,
  attempt: number,
): string {
  return join(
    flowDir,
    "worktrees",
    `${safeName(featureId)}__attempt-${String(attempt).padStart(2, "0")}`,
  );
}

async function commitDirtyWorktree(
  path: string,
  featureId: string,
  attempt: number,
): Promise<void> {
  const status = await gitRun(path, ["status", "--porcelain"]);
  if (status.stdout.trim() === "") return;
  await gitRun(path, ["add", "-A"]);
  await gitRun(path, [
    "commit",
    "-m",
    `feat(${featureId}): gflow attempt ${String(attempt).padStart(2, "0")}`,
  ]);
}

async function gitAvailable(cwd: string): Promise<boolean> {
  const r = await spawnPiped(["git", "rev-parse", "--is-inside-work-tree"], {
    cwd,
    timeoutMs: GIT_TIMEOUT_MS,
  });
  return r.ok && r.stdout.trim() === "true";
}

async function hasHead(cwd: string): Promise<boolean> {
  const r = await spawnPiped(["git", "rev-parse", "--verify", "HEAD"], {
    cwd,
    timeoutMs: GIT_TIMEOUT_MS,
  });
  return r.ok;
}

async function gitRun(cwd: string, args: string[]) {
  const r = await spawnPiped(["git", ...args], { cwd, timeoutMs: GIT_TIMEOUT_MS });
  if (!r.ok) {
    throw new Error(
      `git ${args.join(" ")} failed in ${cwd}: ${r.stderr || r.stdout || `exit=${r.exitCode}`}`,
    );
  }
  return r;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function featureBranch(flowId: string, featureId: string, attempt: number): string {
  return `gflow/${safeName(flowId)}/${safeName(featureId)}/attempt-${String(attempt).padStart(2, "0")}`;
}

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "-");
}

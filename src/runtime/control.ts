import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { flowDir, gflowRoot } from "./state.ts";

export const FlowControl = z.object({
  pause_requested: z.boolean().default(false),
  reason: z.string().optional(),
  requested_at: z.string().optional(),
});
export type FlowControlT = z.infer<typeof FlowControl>;

export const RunLock = z.object({
  pid: z.number().int().positive(),
  started_at: z.string(),
  heartbeat_at: z.string(),
  current_action: z.string().optional(),
});
export type RunLockT = z.infer<typeof RunLock>;

export class RunLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunLockError";
  }
}

export function controlPath(flowId: string, root: string = gflowRoot()): string {
  return join(flowDir(flowId, root), "control.json");
}

export function lockPath(flowId: string, root: string = gflowRoot()): string {
  return join(flowDir(flowId, root), "run.lock");
}

export async function readControl(
  flowId: string,
  root: string = gflowRoot(),
): Promise<FlowControlT> {
  try {
    const raw = await readFile(controlPath(flowId, root), "utf8");
    return FlowControl.parse(JSON.parse(raw));
  } catch {
    return { pause_requested: false };
  }
}

export async function writeControl(
  flowId: string,
  control: FlowControlT,
  root: string = gflowRoot(),
): Promise<void> {
  const path = controlPath(flowId, root);
  await atomicWrite(path, JSON.stringify(FlowControl.parse(control), null, 2) + "\n");
}

export async function requestPause(
  flowId: string,
  reason = "requested by user",
  root: string = gflowRoot(),
): Promise<FlowControlT> {
  const control = {
    pause_requested: true,
    reason,
    requested_at: new Date().toISOString(),
  };
  await writeControl(flowId, control, root);
  return control;
}

export async function clearPause(
  flowId: string,
  root: string = gflowRoot(),
): Promise<void> {
  await writeControl(flowId, { pause_requested: false }, root);
}

export async function acquireRunLock(
  flowId: string,
  root: string = gflowRoot(),
  staleMs = 60_000,
): Promise<RunLockT> {
  const path = lockPath(flowId, root);
  const existing = await readRunLock(flowId, root);
  if (existing) {
    const fresh = Date.now() - Date.parse(existing.heartbeat_at) <= staleMs;
    if (fresh && isPidAlive(existing.pid)) {
      throw new RunLockError(
        `flow ${flowId} already has a live runner pid=${existing.pid}`,
      );
    }
    await archiveRunLock(path);
  }
  const now = new Date().toISOString();
  const lock = { pid: process.pid, started_at: now, heartbeat_at: now };
  await atomicWrite(path, JSON.stringify(lock, null, 2) + "\n");
  return lock;
}

export async function heartbeatRunLock(
  flowId: string,
  currentAction: string,
  root: string = gflowRoot(),
): Promise<void> {
  const existing = await readRunLock(flowId, root);
  const now = new Date().toISOString();
  await atomicWrite(
    lockPath(flowId, root),
    JSON.stringify(
      {
        pid: existing?.pid ?? process.pid,
        started_at: existing?.started_at ?? now,
        heartbeat_at: now,
        current_action: currentAction,
      },
      null,
      2,
    ) + "\n",
  );
}

export async function releaseRunLock(
  flowId: string,
  root: string = gflowRoot(),
): Promise<void> {
  try {
    await unlink(lockPath(flowId, root));
  } catch {
    // Already gone.
  }
}

export async function readRunLock(
  flowId: string,
  root: string = gflowRoot(),
): Promise<RunLockT | null> {
  try {
    const raw = await readFile(lockPath(flowId, root), "utf8");
    return RunLock.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function archiveRunLock(path: string): Promise<void> {
  const archived = `${path}.stale-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  try {
    await rename(path, archived);
  } catch {
    // Missing or raced with another cleanup. The atomic write below will decide.
  }
}

async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  await writeFile(tmp, content, "utf8");
  await rename(tmp, path);
}

import { readdir, readFile, rename, writeFile, unlink, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { flowDir, gflowRoot } from "../runtime/state.ts";

export interface OutboxFile {
  /** Absolute file path. */
  path: string;
  /** Filename only. */
  name: string;
  /** Lifecycle state. */
  state: "queued" | "synced" | "failed" | "legacy-consumed" | "split";
}

const SUFFIX_SYNCED = ".synced";
const SUFFIX_FAILED = ".failed";
const SUFFIX_FAILED_ERR = ".failed.error.txt";
const SUFFIX_LEGACY = ".legacy-consumed";
const SUFFIX_LAST_DRAIN = ".last-drain.json";
const SUFFIX_LOCK = ".drain.lock";

/** Path to the outbox directory for a flow. */
export function outboxDir(flow_id: string, root: string = gflowRoot()): string {
  return join(flowDir(flow_id, root), "gbrain-queue");
}

/**
 * List outbox files. By default returns queued (`*.jsonl` with no further suffix)
 * plus, when `includeFailed`, the `.jsonl.failed` set. Other suffixes are
 * exposed via `includeSynced`/`includeLegacy` for dashboard reads.
 */
export async function enumerateOutbox(
  flow_id: string,
  opts: {
    root?: string;
    includeFailed?: boolean;
    includeSynced?: boolean;
    includeLegacy?: boolean;
  } = {},
): Promise<OutboxFile[]> {
  const dir = outboxDir(flow_id, opts.root);
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }
  const out: OutboxFile[] = [];
  for (const name of files.sort()) {
    if (name.startsWith(".")) continue; // skip .drain.lock / .last-drain.json
    if (name.includes(".tmp.")) continue;
    if (name.endsWith(SUFFIX_FAILED_ERR)) continue;
    const path = join(dir, name);
    if (name.endsWith(SUFFIX_LEGACY)) {
      if (opts.includeLegacy) out.push({ path, name, state: "legacy-consumed" });
      continue;
    }
    if (name.endsWith(SUFFIX_SYNCED)) {
      if (opts.includeSynced) out.push({ path, name, state: "synced" });
      continue;
    }
    if (name.endsWith(SUFFIX_FAILED)) {
      if (opts.includeFailed) out.push({ path, name, state: "failed" });
      continue;
    }
    if (name.endsWith(".jsonl")) {
      out.push({ path, name, state: "queued" });
    }
  }
  return out;
}

/**
 * Atomically rename a queued file to its `.synced` form.
 * Returns the new absolute path.
 */
export async function renameToSynced(absPath: string): Promise<string> {
  const dest = absPath + SUFFIX_SYNCED;
  await rename(absPath, dest);
  return dest;
}

/**
 * Atomically rename a queued file to its `.failed` form and write a
 * sibling `<file>.failed.error.txt` with the error message.
 */
export async function renameToFailed(absPath: string, errMessage: string): Promise<string> {
  const dest = absPath + SUFFIX_FAILED;
  await rename(absPath, dest);
  const errPath = dest + ".error.txt";
  await writeFile(errPath, truncate(errMessage, 4000), "utf8");
  return dest;
}

/**
 * Move a `.failed` file back to plain `.jsonl` so it can be retried.
 * Also removes the companion `.failed.error.txt`. Returns the new path.
 */
export async function retryReset(failedPath: string): Promise<string> {
  if (!failedPath.endsWith(SUFFIX_FAILED)) {
    throw new Error(`retryReset expects a .failed path, got ${failedPath}`);
  }
  const queued = failedPath.slice(0, -SUFFIX_FAILED.length);
  await rename(failedPath, queued);
  try {
    await unlink(failedPath + ".error.txt");
  } catch {
    // best-effort
  }
  return queued;
}

/**
 * Mark a multi-line file as consumed after its lines have been split out.
 */
export async function renameToLegacyConsumed(absPath: string): Promise<string> {
  const dest = absPath + SUFFIX_LEGACY;
  await rename(absPath, dest);
  return dest;
}

/**
 * Best-effort exclusive lock for drain. Returns true if acquired.
 * The lock file holds {pid, started_at}. Stale locks (older than 10 min) are reclaimed.
 */
export async function acquireDrainLock(
  flow_id: string,
  root: string = gflowRoot(),
): Promise<boolean> {
  const dir = outboxDir(flow_id, root);
  await mkdir(dir, { recursive: true });
  const lockPath = join(dir, SUFFIX_LOCK);
  try {
    const raw = await readFile(lockPath, "utf8");
    const parsed = JSON.parse(raw) as { pid: number; started_at: string };
    const age = Date.now() - Date.parse(parsed.started_at);
    if (age < 10 * 60 * 1000) return false; // active lock
  } catch {
    // no lock or unreadable — proceed
  }
  const payload = JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() });
  await writeFile(lockPath, payload, "utf8");
  return true;
}

export async function releaseDrainLock(
  flow_id: string,
  root: string = gflowRoot(),
): Promise<void> {
  const dir = outboxDir(flow_id, root);
  try {
    await unlink(join(dir, SUFFIX_LOCK));
  } catch {
    // best-effort
  }
}

/**
 * Read the persisted last-drain summary. Returns null if missing/unreadable.
 */
export async function readLastDrain(
  flow_id: string,
  root: string = gflowRoot(),
): Promise<unknown | null> {
  try {
    const raw = await readFile(join(outboxDir(flow_id, root), SUFFIX_LAST_DRAIN), "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function writeLastDrain(
  flow_id: string,
  summary: object,
  root: string = gflowRoot(),
): Promise<void> {
  const dir = outboxDir(flow_id, root);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, SUFFIX_LAST_DRAIN), JSON.stringify(summary, null, 2), "utf8");
}

/**
 * Per-flow monotonic counter for collision-free filenames. Process-local;
 * combined with `pid` in the filename ensures cross-process uniqueness.
 */
const counters = new Map<string, number>();

export function nextOutboxSeq(flow_id: string): number {
  const next = (counters.get(flow_id) ?? 0) + 1;
  counters.set(flow_id, next);
  return next;
}

/** Test seam — reset the counter map (used by gbrain tests with temp roots). */
export function __resetOutboxCounters(): void {
  counters.clear();
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "\n[…truncated]" : s;
}

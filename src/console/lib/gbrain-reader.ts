import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { flowDir, gflowRoot } from "../../runtime/state.ts";
import type { GbrainKind } from "../../gbrain/client.ts";

export type SyncState = "queued" | "synced" | "failed";

export interface GbrainEntry {
  kind: GbrainKind | string;
  recorded_at: string;
  payload: Record<string, unknown>;
  file: string;
  sync_state: SyncState;
}

export interface GbrainQueueRead {
  entries: GbrainEntry[];
  queue: { queued: number; synced: number; failed: number };
  counts: { feature_close: number; milestone_close: number; flow_complete: number };
}

/**
 * Enumerate + parse `.gflow/<flow_id>/gbrain-queue/` files.
 *
 * Reads three suffix variants and annotates each entry with its sync_state:
 *   `*.jsonl`         → "queued"
 *   `*.jsonl.synced`  → "synced"
 *   `*.jsonl.failed`  → "failed"
 *
 * Sorted newest first by `recorded_at`. Tolerates corrupt JSONL lines and
 * non-jsonl files. Hidden files (`.drain.lock`, `.last-drain.json`,
 * `.legacy-consumed`, `.tmp.*`, `.error.txt`) are ignored.
 */
export async function readGbrainQueue(
  flow_id: string,
  root: string = gflowRoot(),
): Promise<GbrainQueueRead> {
  const dir = join(flowDir(flow_id, root), "gbrain-queue");
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return emptyResult();
  }
  files = files
    .filter((f) => !f.startsWith("."))
    .filter((f) => !f.includes(".tmp."))
    .filter((f) => !f.endsWith(".error.txt"))
    .filter((f) => !f.endsWith(".legacy-consumed"))
    .sort()
    .reverse();

  const entries: GbrainEntry[] = [];
  for (const f of files) {
    const sync_state = classifySuffix(f);
    if (sync_state === null) continue;
    let raw: string;
    try {
      raw = await readFile(join(dir, f), "utf8");
    } catch {
      continue;
    }
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const obj = JSON.parse(trimmed);
        if (obj && typeof obj === "object" && obj.kind && obj.recorded_at) {
          entries.push({
            kind: obj.kind as GbrainKind | string,
            recorded_at: String(obj.recorded_at),
            payload: (obj.payload ?? {}) as Record<string, unknown>,
            file: f,
            sync_state,
          });
        }
      } catch {
        // unparseable line — skip silently (dashboard surfaces .failed via filename)
      }
    }
  }
  entries.sort((a, b) => (a.recorded_at < b.recorded_at ? 1 : a.recorded_at > b.recorded_at ? -1 : 0));

  const queue = { queued: 0, synced: 0, failed: 0 };
  const counts = { feature_close: 0, milestone_close: 0, flow_complete: 0 };
  for (const e of entries) {
    queue[e.sync_state] += 1;
    if (e.kind === "feature_close" || e.kind === "milestone_close" || e.kind === "flow_complete") {
      counts[e.kind] += 1;
    }
  }
  return { entries, queue, counts };
}

function emptyResult(): GbrainQueueRead {
  return {
    entries: [],
    queue: { queued: 0, synced: 0, failed: 0 },
    counts: { feature_close: 0, milestone_close: 0, flow_complete: 0 },
  };
}

function classifySuffix(name: string): SyncState | null {
  if (name.endsWith(".jsonl.synced")) return "synced";
  if (name.endsWith(".jsonl.failed")) return "failed";
  if (name.endsWith(".jsonl")) return "queued";
  return null;
}

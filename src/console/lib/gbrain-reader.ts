import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { flowDir, gflowRoot } from "../../runtime/state.ts";
import type { GbrainKind } from "../../gbrain/client.ts";

export interface GbrainEntry {
  kind: GbrainKind;
  recorded_at: string;
  payload: Record<string, unknown>;
  file: string;
}

export interface GbrainQueueRead {
  entries: GbrainEntry[];
  counts: { feature_close: number; milestone_close: number; flow_complete: number };
}

/**
 * Enumerate + parse `.gflow/<flow_id>/gbrain-queue/*.jsonl`. Sorted newest
 * first. Tolerates files with single-line or multi-line JSONL bodies and
 * ignores non-jsonl files / unparseable lines.
 */
export async function readGbrainQueue(
  flow_id: string,
  root: string = gflowRoot(),
): Promise<GbrainQueueRead> {
  const dir = join(flowDir(flow_id, root), "gbrain-queue");
  let files: string[];
  try {
    files = (await readdir(dir))
      .filter((f) => f.endsWith(".jsonl") && !f.includes(".tmp."))
      .sort()
      .reverse();
  } catch {
    return {
      entries: [],
      counts: { feature_close: 0, milestone_close: 0, flow_complete: 0 },
    };
  }

  const entries: GbrainEntry[] = [];
  for (const f of files) {
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
            kind: obj.kind as GbrainKind,
            recorded_at: String(obj.recorded_at),
            payload: (obj.payload ?? {}) as Record<string, unknown>,
            file: f,
          });
        }
      } catch {
        // skip unparseable line
      }
    }
  }
  // Re-sort by recorded_at desc (filenames already approximate this, but the
  // ISO timestamp is the canonical order).
  entries.sort((a, b) => (a.recorded_at < b.recorded_at ? 1 : a.recorded_at > b.recorded_at ? -1 : 0));

  const counts = { feature_close: 0, milestone_close: 0, flow_complete: 0 };
  for (const e of entries) {
    if (e.kind in counts) counts[e.kind] += 1;
  }
  return { entries, counts };
}

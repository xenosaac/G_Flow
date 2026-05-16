import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { flowDir, gflowRoot } from "../runtime/state.ts";

let warned = false;

export type GbrainKind = "feature_close" | "milestone_close" | "flow_complete";

export interface GbrainSnapshot {
  flow_id: string;
  kind: GbrainKind;
  recorded_at: string;
  payload: Record<string, unknown>;
}

const inFlight = new Map<string, Promise<void>>();

/**
 * Fire-and-forget snapshot enqueue. NEVER awaits the actual write — the
 * runtime must not be blocked by GBrain availability.
 *
 * V1 behavior: write a JSONL line under .gflow/<flow_id>/gbrain-queue/.
 * V2 (TODOS T5): POST to GBrain when GBRAIN_API_KEY is present.
 */
export function enqueueSnapshot(snapshot: GbrainSnapshot): void {
  const prev = inFlight.get(snapshot.flow_id) ?? Promise.resolve();
  const next = prev
    .then(() => writeSnapshot(snapshot))
    .catch((err) => {
      // Per spec: missing config → warn-and-continue. Never throw.
      console.warn(
        `gbrain: snapshot ${snapshot.kind} for ${snapshot.flow_id} failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    });
  inFlight.set(snapshot.flow_id, next);
}

/** Test/CLI helper: await pending writes. Never used in the hot path. */
export async function flushGbrain(flow_id?: string): Promise<void> {
  if (flow_id) {
    await (inFlight.get(flow_id) ?? Promise.resolve());
    return;
  }
  await Promise.all(Array.from(inFlight.values()));
}

async function writeSnapshot(snapshot: GbrainSnapshot): Promise<void> {
  if (!process.env.GBRAIN_API_KEY) {
    if (!warned) {
      console.warn(
        "gbrain: GBRAIN_API_KEY not set; queuing snapshots to local JSONL only (V2 will POST these). See TODOS.md T5.",
      );
      warned = true;
    }
  }
  // V1: always write locally. V2 (T5) will additionally POST when key present.
  await writeLocal(snapshot);
}

async function writeLocal(snapshot: GbrainSnapshot): Promise<void> {
  const root = gflowRoot();
  const dir = join(flowDir(snapshot.flow_id, root), "gbrain-queue");
  await mkdir(dir, { recursive: true });
  const safe = snapshot.recorded_at.replace(/[:.]/g, "-");
  const path = join(dir, `${safe}_${snapshot.kind}.jsonl`);
  await appendFile(path, JSON.stringify(snapshot) + "\n", "utf8");
}

/** Test seam — reset the one-time warned flag. */
export function __resetGbrainWarned(): void {
  warned = false;
}

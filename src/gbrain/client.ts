import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { flowDir, gflowRoot } from "../runtime/state.ts";
import {
  GbrainSnapshotV2,
  type GbrainSnapshotV2T,
  type GbrainKindV2T,
} from "./snapshot.ts";
import { nextOutboxSeq, outboxDir } from "./outbox.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */

let modeWarnedOnce = false;
let deprecationWarnedOnce = false;

/**
 * Legacy thin payload kept for back-compat with V1 callers that still emit
 * `{flow_id, kind, recorded_at, payload}` blobs. New callers must construct
 * GbrainSnapshotV2 directly via the builders in `./snapshot.ts`.
 */
export type GbrainKind = "feature_close" | "milestone_close" | "flow_complete";

export interface GbrainSnapshot {
  flow_id: string;
  kind: GbrainKind;
  recorded_at: string;
  payload: Record<string, unknown>;
}

const inFlight = new Map<string, Promise<void>>();

/**
 * Fire-and-forget snapshot enqueue. Synchronous return, NEVER blocks the runtime.
 *
 * The actual `appendFile` happens later inside the per-flow promise chain. CLI
 * command handlers and `runFlow()` MUST `await flushGbrain(flow_id)` before
 * returning, otherwise `process.exit` will drop pending writes.
 *
 * Accepts both `GbrainSnapshotV2` (schema_version: 2) and the legacy thin
 * shape. V2 payloads are written to their own per-snapshot file with a
 * monotonic seq counter so the drain pipeline never sees multi-line files
 * produced by this code path; legacy multi-line files (from older versions)
 * are handled by the drain split step.
 */
export function enqueueSnapshot(snapshot: GbrainSnapshotV2T | GbrainSnapshot): void {
  appendToOutbox(snapshot);
}

/**
 * Canonical internal writer. `enqueueSnapshot` delegates here so there is
 * exactly one code path that appends to `.gflow/<flow_id>/gbrain-queue/`.
 */
export function appendToOutbox(snapshot: GbrainSnapshotV2T | GbrainSnapshot): void {
  warnOnceAboutMode();
  const flow_id = snapshot.flow_id;
  const prev = inFlight.get(flow_id) ?? Promise.resolve();
  const next = prev
    .then(() => writeSnapshot(snapshot))
    .catch((err) => {
      console.warn(
        `gbrain: snapshot ${snapshot.kind} for ${flow_id} failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    });
  inFlight.set(flow_id, next);
}

/**
 * **MUST be awaited before process exit** by every CLI command handler and
 * request handler. Promise chains aren't durability — without flushing here,
 * `process.exit()` can drop pending JSONL writes.
 *
 * Passing `flow_id` flushes only that flow; omitting flushes all flows.
 */
export async function flushGbrain(flow_id?: string): Promise<void> {
  if (flow_id) {
    await (inFlight.get(flow_id) ?? Promise.resolve());
    return;
  }
  await Promise.all(Array.from(inFlight.values()));
}

async function writeSnapshot(snapshot: GbrainSnapshotV2T | GbrainSnapshot): Promise<void> {
  await writeLocal(snapshot);
}

async function writeLocal(snapshot: GbrainSnapshotV2T | GbrainSnapshot): Promise<void> {
  const root = gflowRoot();
  const dir = outboxDir(snapshot.flow_id, root);
  await mkdir(dir, { recursive: true });

  const seq = nextOutboxSeq(snapshot.flow_id);
  const ts = String(snapshot.recorded_at ?? new Date().toISOString());
  const safeTs = ts.replace(/[:.]/g, "-");
  const kindSeg = String((snapshot as any).kind ?? "snapshot");
  const name = `${safeTs}__p${process.pid}__s${String(seq).padStart(4, "0")}__${kindSeg}.jsonl`;
  const path = join(dir, name);

  // Coerce a legacy thin payload into a V2 snapshot when possible so all
  // entries on disk are consistent (drain/dashboard read V2). Validate when
  // we can; fall back to passing the legacy blob through if it has no
  // schema_version field.
  const v2 = (snapshot as any).schema_version === 2
    ? GbrainSnapshotV2.parse(snapshot)
    : snapshot;

  await appendFile(path, JSON.stringify(v2) + "\n", "utf8");
}

function warnOnceAboutMode(): void {
  if (modeWarnedOnce) return;
  const mode = process.env.GBRAIN_MODE;
  const apiKey = process.env.GBRAIN_API_KEY;
  if (!mode && apiKey && !deprecationWarnedOnce) {
    console.warn(
      "gbrain: GBRAIN_API_KEY is deprecated; set GBRAIN_MODE=mcp-http and GBRAIN_AUTH_TOKEN to enable real integration.",
    );
    deprecationWarnedOnce = true;
  }
  if (!mode || mode === "off") {
    // Stay quiet — explicit off mode is fine.
  }
  modeWarnedOnce = true;
}

/** Test seam — reset one-time warning state. */
export function __resetGbrainWarned(): void {
  modeWarnedOnce = false;
  deprecationWarnedOnce = false;
}

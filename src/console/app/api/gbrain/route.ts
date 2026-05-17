import { latestFlow } from "../../../../runtime/state.ts";
import { readGbrainQueue } from "../../../lib/gbrain-reader.ts";
import { selectAdapter, readLastDrain } from "../../../../gbrain/adapter.ts";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  let flow_id = url.searchParams.get("flow_id");
  if (!flow_id) {
    const latest = await latestFlow();
    flow_id = latest?.flow_id ?? null;
  }
  const adapter = selectAdapter();
  // Bound the health check so a slow/broken backend can't stall the dashboard.
  const health = await Promise.race([
    adapter.health(),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 3500)),
  ]);
  const healthOut = health ?? {
    mode: adapter.mode,
    ok: false,
    reason: "http_unreachable" as const,
    detail: "health probe timed out",
    warnings: [] as string[],
    source_id: adapter.source_id,
    checked_at: new Date().toISOString(),
  };

  if (!flow_id) {
    return Response.json({
      flow_id: null,
      mode: adapter.mode,
      source_id: adapter.source_id,
      health: healthOut,
      queue: { queued: 0, synced: 0, failed: 0 },
      last_drain: null,
      last_error: null,
      entries: [],
      counts: { feature_close: 0, milestone_close: 0, flow_complete: 0 },
    });
  }

  const result = await readGbrainQueue(flow_id);
  const last_drain = await readLastDrain(flow_id);
  const last_error =
    last_drain?.errors && last_drain.errors.length > 0
      ? last_drain.errors[last_drain.errors.length - 1]?.message ?? null
      : null;

  return Response.json({
    flow_id,
    mode: adapter.mode,
    source_id: adapter.source_id,
    health: healthOut,
    queue: result.queue,
    last_drain: last_drain
      ? {
          started_at: last_drain.started_at,
          finished_at: last_drain.finished_at,
          drained: last_drain.drained,
          synced: last_drain.synced,
          failed: last_drain.failed,
        }
      : null,
    last_error,
    entries: result.entries,
    counts: result.counts,
  });
}

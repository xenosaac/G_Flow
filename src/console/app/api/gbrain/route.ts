import { latestFlow } from "../../../../runtime/state.ts";
import { readGbrainQueue } from "../../../lib/gbrain-reader.ts";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  let flow_id = url.searchParams.get("flow_id");
  if (!flow_id) {
    const latest = await latestFlow();
    flow_id = latest?.flow_id ?? null;
  }
  if (!flow_id) {
    return Response.json({
      flow_id: null,
      entries: [],
      counts: { feature_close: 0, milestone_close: 0, flow_complete: 0 },
    });
  }
  const result = await readGbrainQueue(flow_id);
  return Response.json({ flow_id, ...result });
}

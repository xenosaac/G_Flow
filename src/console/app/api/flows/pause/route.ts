import { pauseFlowAPI } from "../../../../../runtime/flow-control.ts";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let body: { flow_id?: string; reason?: string };
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  try {
    const result = await pauseFlowAPI({
      flow_id: body.flow_id,
      reason: body.reason,
    });
    return Response.json({ ok: true, ...result });
  } catch (err) {
    return Response.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

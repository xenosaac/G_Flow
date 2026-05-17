import { latestFlow } from "../../../../../runtime/state.ts";
import { selectAdapter } from "../../../../../gbrain/adapter.ts";

export const dynamic = "force-dynamic";

interface DrainBody {
  flow_id?: string;
}

export async function POST(req: Request) {
  let body: DrainBody = {};
  try {
    if (req.headers.get("content-type")?.includes("application/json")) {
      body = (await req.json()) as DrainBody;
    }
  } catch {
    // ignore malformed body; treat as {}
  }

  const adapter = selectAdapter();
  if (adapter.mode === "off") {
    return Response.json(
      {
        ok: false,
        error: "GBrain mode is off. Set GBRAIN_MODE=local-cli or mcp-http to enable.",
        mode: adapter.mode,
      },
      { status: 503 },
    );
  }

  let flow_id = body.flow_id;
  if (!flow_id) {
    const latest = await latestFlow();
    flow_id = latest?.flow_id ?? undefined;
  }

  const result = await adapter.drainOutbox(flow_id);
  return Response.json(result);
}

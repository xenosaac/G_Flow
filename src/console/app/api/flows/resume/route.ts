import { resumeFlowAPI } from "../../../../../runtime/flow-control.ts";
import { selectBackend, UnknownBackendError } from "../../../../../adapters/select.ts";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let body: { flow_id?: string; backend?: string; target_dir?: string; target_url?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
  }

  let backend;
  try {
    backend = await selectBackend(body.backend);
  } catch (err) {
    if (err instanceof UnknownBackendError) {
      return Response.json({ ok: false, error: err.message }, { status: 400 });
    }
    throw err;
  }
  if (!backend) {
    return Response.json(
      { ok: false, error: "cannot resume with backend=none" },
      { status: 400 },
    );
  }

  try {
    const result = await resumeFlowAPI({
      flow_id: body.flow_id,
      target_dir: body.target_dir,
      target_url: body.target_url,
      backend,
    });
    return Response.json({ ok: true, ...result });
  } catch (err) {
    return Response.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

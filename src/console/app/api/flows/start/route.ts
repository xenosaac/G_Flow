import { startFlowAPI, PlannerError } from "../../../../../runtime/flow-control.ts";
import { selectBackend, UnknownBackendError } from "../../../../../adapters/select.ts";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let body: { goal?: string; backend?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
  }
  const goal = String(body.goal ?? "").trim();
  if (!goal) {
    return Response.json({ ok: false, error: "goal required" }, { status: 400 });
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
      { ok: false, error: "cannot start flow with backend=none" },
      { status: 400 },
    );
  }

  try {
    const result = await startFlowAPI({ goal, backend });
    return Response.json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof PlannerError) {
      return Response.json(
        {
          ok: false,
          error: err.message,
          issues: err.issues,
        },
        { status: 422 },
      );
    }
    return Response.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

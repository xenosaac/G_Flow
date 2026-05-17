import {
  PlanningReviewError,
  PlannerError,
  clarifyFlowAPI,
} from "../../../../../runtime/flow-control.ts";
import { selectBackend, UnknownBackendError } from "../../../../../adapters/select.ts";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let body: {
    flow_id?: string;
    backend?: string;
    answers?: { question_id?: string; answer?: string }[];
  };
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
  }
  const flowId = String(body.flow_id ?? "").trim();
  if (!flowId) {
    return Response.json({ ok: false, error: "flow_id required" }, { status: 400 });
  }
  const answers = (body.answers ?? [])
    .map((a) => ({
      question_id: String(a.question_id ?? "").trim(),
      answer: String(a.answer ?? "").trim(),
    }))
    .filter((a) => a.question_id && a.answer);
  if (answers.length === 0) {
    return Response.json({ ok: false, error: "answers required" }, { status: 400 });
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
      { ok: false, error: "cannot clarify with backend=none" },
      { status: 400 },
    );
  }

  try {
    const result = await clarifyFlowAPI({
      flow_id: flowId,
      answers,
      backend,
    });
    return Response.json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof PlannerError || err instanceof PlanningReviewError) {
      return Response.json(
        { ok: false, error: err.message, issues: err.issues },
        { status: 422 },
      );
    }
    return Response.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

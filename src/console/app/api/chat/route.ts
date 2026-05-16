import { sendChat, newSessionId } from "../../../../runtime/chat.ts";
import { selectBackend, UnknownBackendError } from "../../../../adapters/select.ts";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let body: { session_id?: string; backend?: string; message?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
  }
  const message = String(body.message ?? "").trim();
  if (!message) {
    return Response.json({ ok: false, error: "message required" }, { status: 400 });
  }
  const sessionId = body.session_id || newSessionId();

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
      { ok: false, error: "cannot chat with backend=none; pick claude-code or codex" },
      { status: 400 },
    );
  }

  try {
    const result = await sendChat({
      session_id: sessionId,
      backend,
      message,
      cwd: process.cwd(),
    });
    return Response.json({
      ok: result.ok,
      session_id: sessionId,
      reply: result.reply,
      exit_code: result.exit_code,
      timed_out: result.timedOut,
      transcript_path: result.transcript_path,
    });
  } catch (err) {
    return Response.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

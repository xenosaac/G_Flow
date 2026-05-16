import { readLatestSnapshot, snapshotMtime } from "../../../lib/snapshot.ts";

export const dynamic = "force-dynamic";

const ENCODER = new TextEncoder();

export async function GET(req: Request) {
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      let lastMtime = -1;

      function send(payload: unknown) {
        if (closed) return;
        controller.enqueue(
          ENCODER.encode(`data: ${JSON.stringify(payload)}\n\n`),
        );
      }

      async function tick() {
        try {
          const snap = await readLatestSnapshot();
          if (!snap) {
            send({ type: "no_flow" });
            return;
          }
          const m = await snapshotMtime(snap.flow_id);
          if (m !== lastMtime) {
            send({ type: "snapshot", data: snap });
            lastMtime = m;
          }
        } catch (err) {
          send({
            type: "error",
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }

      await tick();
      const interval = setInterval(tick, 1000);

      // Heartbeat every 15s to keep the stream alive through proxies
      const heartbeat = setInterval(() => {
        if (!closed) {
          controller.enqueue(ENCODER.encode(`: heartbeat\n\n`));
        }
      }, 15000);

      req.signal.addEventListener("abort", () => {
        closed = true;
        clearInterval(interval);
        clearInterval(heartbeat);
        try {
          controller.close();
        } catch {
          // already closed
        }
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

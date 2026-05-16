import { listBackends } from "../../../lib/server-backend.ts";

export const dynamic = "force-dynamic";

export async function GET() {
  const backends = listBackends();
  return Response.json({ backends });
}

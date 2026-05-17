import { runCollegeWebsiteDemo } from "../../../../../runtime/demo-college.ts";
import { readSnapshot } from "../../../../lib/snapshot.ts";

export const dynamic = "force-dynamic";

export async function POST() {
  try {
    const result = await runCollegeWebsiteDemo();
    const snapshot = await readSnapshot(result.flow_id);
    return Response.json({ ok: true, ...result, snapshot });
  } catch (err) {
    return Response.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

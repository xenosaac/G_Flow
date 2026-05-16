import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readGbrainQueue } from "../src/console/lib/gbrain-reader.ts";
import { enqueueSnapshot, flushGbrain, __resetGbrainWarned } from "../src/gbrain/client.ts";

let TMP: string;
let prevRoot: string | undefined;
const FLOW = "f_gb_read_0001";

beforeEach(async () => {
  TMP = join(tmpdir(), `gflow-gbread-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  await mkdir(join(TMP, FLOW, "gbrain-queue"), { recursive: true });
  prevRoot = process.env.GFLOW_ROOT;
  process.env.GFLOW_ROOT = TMP;
  __resetGbrainWarned();
});

afterEach(async () => {
  if (prevRoot === undefined) delete process.env.GFLOW_ROOT;
  else process.env.GFLOW_ROOT = prevRoot;
  await rm(TMP, { recursive: true, force: true });
});

describe("readGbrainQueue", () => {
  test("empty dir → empty entries, zero counts", async () => {
    const r = await readGbrainQueue(FLOW, TMP);
    expect(r.entries).toEqual([]);
    expect(r.counts).toEqual({ feature_close: 0, milestone_close: 0, flow_complete: 0 });
  });

  test("parses one of each kind + correct counts", async () => {
    enqueueSnapshot({ flow_id: FLOW, kind: "feature_close", recorded_at: "2026-05-16T11:00:00.000Z", payload: { feature_id: "F-001" } });
    enqueueSnapshot({ flow_id: FLOW, kind: "feature_close", recorded_at: "2026-05-16T11:01:00.000Z", payload: { feature_id: "F-002" } });
    enqueueSnapshot({ flow_id: FLOW, kind: "milestone_close", recorded_at: "2026-05-16T11:02:00.000Z", payload: { milestone_id: "M-001" } });
    enqueueSnapshot({ flow_id: FLOW, kind: "flow_complete", recorded_at: "2026-05-16T11:03:00.000Z", payload: {} });
    await flushGbrain(FLOW);

    const r = await readGbrainQueue(FLOW, TMP);
    expect(r.counts).toEqual({ feature_close: 2, milestone_close: 1, flow_complete: 1 });
    expect(r.entries).toHaveLength(4);
    expect(r.entries[0]!.kind).toBe("flow_complete"); // newest first
    expect(r.entries[3]!.kind).toBe("feature_close"); // oldest last
  });

  test("ignores .tmp.* and non-jsonl files", async () => {
    const dir = join(TMP, FLOW, "gbrain-queue");
    await writeFile(join(dir, "2026-05-16T11-00-00-000Z_feature_close.jsonl"), JSON.stringify({
      flow_id: FLOW, kind: "feature_close", recorded_at: "2026-05-16T11:00:00.000Z", payload: { feature_id: "F-001" },
    }) + "\n", "utf8");
    await writeFile(join(dir, "junk.txt"), "not json", "utf8");
    await writeFile(join(dir, "stale.jsonl.tmp.12345"), "rubbish", "utf8");
    const r = await readGbrainQueue(FLOW, TMP);
    expect(r.entries).toHaveLength(1);
    expect(r.counts.feature_close).toBe(1);
  });

  test("missing flow dir → empty (no throw)", async () => {
    const r = await readGbrainQueue("f_does_not_exist", TMP);
    expect(r.entries).toEqual([]);
  });

  test("skips unparseable lines but keeps good ones", async () => {
    const dir = join(TMP, FLOW, "gbrain-queue");
    const path = join(dir, "2026-05-16T11-00-00-000Z_feature_close.jsonl");
    await writeFile(
      path,
      [
        "this is not json",
        JSON.stringify({
          flow_id: FLOW,
          kind: "feature_close",
          recorded_at: "2026-05-16T11:00:00.000Z",
          payload: { feature_id: "F-001" },
        }),
        "{ not closed",
      ].join("\n"),
      "utf8",
    );
    const r = await readGbrainQueue(FLOW, TMP);
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0]!.kind).toBe("feature_close");
  });

  test("sorts by recorded_at desc when filenames don't match", async () => {
    const dir = join(TMP, FLOW, "gbrain-queue");
    // Filenames in wrong order on purpose
    await writeFile(
      join(dir, "a.jsonl"),
      JSON.stringify({ flow_id: FLOW, kind: "feature_close", recorded_at: "2026-05-16T11:00:00.000Z", payload: {} }),
      "utf8",
    );
    await writeFile(
      join(dir, "b.jsonl"),
      JSON.stringify({ flow_id: FLOW, kind: "milestone_close", recorded_at: "2026-05-16T11:05:00.000Z", payload: {} }),
      "utf8",
    );
    await writeFile(
      join(dir, "c.jsonl"),
      JSON.stringify({ flow_id: FLOW, kind: "flow_complete", recorded_at: "2026-05-16T11:02:00.000Z", payload: {} }),
      "utf8",
    );
    const r = await readGbrainQueue(FLOW, TMP);
    expect(r.entries.map((e) => e.kind)).toEqual([
      "milestone_close",
      "flow_complete",
      "feature_close",
    ]);
  });
});

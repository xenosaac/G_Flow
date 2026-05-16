import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, rm, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  enqueueSnapshot,
  flushGbrain,
  __resetGbrainWarned,
} from "../src/gbrain/client.ts";

let TMP: string;
let prevRoot: string | undefined;
const FLOW = "f_gb_0001";

beforeEach(async () => {
  TMP = join(
    tmpdir(),
    `gflow-gbrain-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  await mkdir(join(TMP, FLOW), { recursive: true });
  prevRoot = process.env.GFLOW_ROOT;
  process.env.GFLOW_ROOT = TMP;
  __resetGbrainWarned();
});

afterEach(async () => {
  if (prevRoot === undefined) delete process.env.GFLOW_ROOT;
  else process.env.GFLOW_ROOT = prevRoot;
  await rm(TMP, { recursive: true, force: true });
});

describe("enqueueSnapshot", () => {
  test("returns synchronously (does not block)", () => {
    const t0 = Date.now();
    enqueueSnapshot({
      flow_id: FLOW,
      kind: "feature_close",
      recorded_at: new Date().toISOString(),
      payload: { feature_id: "F-001" },
    });
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(50);
  });

  test("writes a JSONL line under .gflow/<flow_id>/gbrain-queue/", async () => {
    enqueueSnapshot({
      flow_id: FLOW,
      kind: "feature_close",
      recorded_at: "2026-05-16T11:00:00.000Z",
      payload: { feature_id: "F-001", milestone_id: "M-001" },
    });
    await flushGbrain(FLOW);
    const dir = join(TMP, FLOW, "gbrain-queue");
    const files = await readdir(dir);
    expect(files.length).toBe(1);
    const raw = await readFile(join(dir, files[0]!), "utf8");
    const parsed = JSON.parse(raw.trim());
    expect(parsed.kind).toBe("feature_close");
    expect(parsed.payload.feature_id).toBe("F-001");
  });

  test("multiple snapshots in the same call queue serialize without dropping", async () => {
    for (let i = 0; i < 5; i++) {
      enqueueSnapshot({
        flow_id: FLOW,
        kind: "feature_close",
        recorded_at: `2026-05-16T11:00:0${i}.000Z`,
        payload: { i },
      });
    }
    await flushGbrain(FLOW);
    const dir = join(TMP, FLOW, "gbrain-queue");
    const files = await readdir(dir);
    expect(files.length).toBe(5);
  });

  test("missing GBRAIN_API_KEY does not throw (warn-and-continue)", async () => {
    const prev = process.env.GBRAIN_API_KEY;
    delete process.env.GBRAIN_API_KEY;
    try {
      __resetGbrainWarned();
      enqueueSnapshot({
        flow_id: FLOW,
        kind: "flow_complete",
        recorded_at: new Date().toISOString(),
        payload: {},
      });
      await flushGbrain(FLOW);
      const dir = join(TMP, FLOW, "gbrain-queue");
      const files = await readdir(dir);
      expect(files.length).toBe(1);
    } finally {
      if (prev !== undefined) process.env.GBRAIN_API_KEY = prev;
    }
  });
});

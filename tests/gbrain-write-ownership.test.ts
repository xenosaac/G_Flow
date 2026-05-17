import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { selectAdapter } from "../src/gbrain/adapter.ts";
import { appendToOutbox, enqueueSnapshot, flushGbrain, __resetGbrainWarned } from "../src/gbrain/client.ts";
import { buildPlanCreated } from "../src/gbrain/snapshot.ts";
import { __resetOutboxCounters } from "../src/gbrain/outbox.ts";

let TMP: string;
let prevRoot: string | undefined;

const TINY = {
  flow_id: "f_own",
  goal: "g",
  created_at: "2026-05-16T00:00:00Z",
  milestones: [
    {
      id: "M-001",
      title: "M",
      endpoint_criteria: "ok",
      features: [
        {
          id: "F-001",
          title: "F",
          spec: "spec",
          assertions: [
            {
              id: "A-001-001",
              text: "a",
              validator: "screwdriver" as const,
              evidence_required: "n/a",
              status: "pending" as const,
              origin: "original" as const,
              attempts: [],
              check: { kind: "file_exists" as const, path: "index.html" },
            },
          ],
        },
      ],
    },
  ],
};

beforeEach(async () => {
  TMP = join(
    tmpdir(),
    `gflow-own-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  await mkdir(join(TMP, "f_own"), { recursive: true });
  prevRoot = process.env.GFLOW_ROOT;
  process.env.GFLOW_ROOT = TMP;
  __resetGbrainWarned();
  __resetOutboxCounters();
});

afterEach(async () => {
  if (prevRoot === undefined) delete process.env.GFLOW_ROOT;
  else process.env.GFLOW_ROOT = prevRoot;
  await rm(TMP, { recursive: true, force: true });
});

function snap(seq: number) {
  return buildPlanCreated({
    flow_id: "f_own",
    source_id: "gflow",
    goal: `g-${seq}`,
    contract: TINY,
  });
}

describe("write ownership: one outbox writer", () => {
  test("adapter.enqueueSnapshot writes exactly one file (no double write)", async () => {
    selectAdapter().enqueueSnapshot(snap(1));
    await flushGbrain("f_own");
    const files = await readdir(join(TMP, "f_own", "gbrain-queue"));
    expect(files.length).toBe(1);
  });

  test("client.appendToOutbox writes exactly one file", async () => {
    appendToOutbox(snap(2));
    await flushGbrain("f_own");
    const files = await readdir(join(TMP, "f_own", "gbrain-queue"));
    expect(files.length).toBe(1);
  });

  test("client.enqueueSnapshot writes exactly one file", async () => {
    enqueueSnapshot(snap(3));
    await flushGbrain("f_own");
    const files = await readdir(join(TMP, "f_own", "gbrain-queue"));
    expect(files.length).toBe(1);
  });

  test("mixed call sites do not double-write — each enqueue produces ONE file", async () => {
    const a = selectAdapter();
    a.enqueueSnapshot(snap(1));
    appendToOutbox(snap(2));
    enqueueSnapshot(snap(3));
    await flushGbrain("f_own");
    const files = await readdir(join(TMP, "f_own", "gbrain-queue"));
    expect(files.length).toBe(3);
  });
});

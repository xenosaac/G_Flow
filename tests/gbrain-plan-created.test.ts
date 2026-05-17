import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, rm, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { emitPlanCreated } from "../src/gbrain/emit.ts";
import { flushGbrain, __resetGbrainWarned } from "../src/gbrain/client.ts";
import { __resetOutboxCounters } from "../src/gbrain/outbox.ts";

let TMP: string;
let prevRoot: string | undefined;
let prevSource: string | undefined;

const TINY_CONTRACT = {
  flow_id: "f_plan",
  goal: "build a static todo app",
  created_at: "2026-05-16T00:00:00Z",
  milestones: [
    {
      id: "M-001",
      title: "M",
      endpoint_criteria: "ok",
      features: [
        {
          id: "F-001",
          title: "F1",
          spec: "spec1",
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
        {
          id: "F-002",
          title: "F2",
          spec: "spec2",
          assertions: [
            {
              id: "A-002-001",
              text: "b",
              validator: "screwdriver" as const,
              evidence_required: "n/a",
              status: "pending" as const,
              origin: "original" as const,
              attempts: [],
              check: { kind: "file_exists" as const, path: "style.css" },
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
    `gflow-plan-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  await mkdir(join(TMP, "f_plan", "gbrain-queue"), { recursive: true });
  prevRoot = process.env.GFLOW_ROOT;
  prevSource = process.env.GBRAIN_SOURCE_ID;
  process.env.GFLOW_ROOT = TMP;
  __resetGbrainWarned();
  __resetOutboxCounters();
});

afterEach(async () => {
  if (prevRoot === undefined) delete process.env.GFLOW_ROOT;
  else process.env.GFLOW_ROOT = prevRoot;
  if (prevSource === undefined) delete process.env.GBRAIN_SOURCE_ID;
  else process.env.GBRAIN_SOURCE_ID = prevSource;
  await rm(TMP, { recursive: true, force: true });
});

describe("plan_created snapshot emission", () => {
  test("emitPlanCreated writes a single jsonl file with expected payload", async () => {
    emitPlanCreated({
      flow_id: "f_plan",
      goal: "build a static todo app",
      contract: TINY_CONTRACT,
    });
    await flushGbrain("f_plan");
    const dir = join(TMP, "f_plan", "gbrain-queue");
    const files = await readdir(dir);
    const planFiles = files.filter((f) => f.endsWith(".jsonl") && f.includes("plan_created"));
    expect(planFiles.length).toBe(1);
    const raw = await readFile(join(dir, planFiles[0]!), "utf8");
    const obj = JSON.parse(raw.trim());
    expect(obj.schema_version).toBe(2);
    expect(obj.kind).toBe("plan_created");
    expect(obj.flow_id).toBe("f_plan");
    expect(obj.payload.goal).toBe("build a static todo app");
    expect(obj.payload.contract_summary).toEqual({
      milestone_count: 1,
      feature_count: 2,
      assertion_count: 2,
    });
    expect(typeof obj.payload.contract_hash).toBe("string");
    expect(obj.payload.contract_hash.length).toBe(16);
    expect(/^[0-9a-f]+$/.test(obj.payload.contract_hash)).toBe(true);
  });

  test("source_id comes from GBRAIN_SOURCE_ID env, defaults to 'gflow'", async () => {
    process.env.GBRAIN_SOURCE_ID = "myteam";
    emitPlanCreated({
      flow_id: "f_plan",
      goal: "g",
      contract: TINY_CONTRACT,
    });
    await flushGbrain("f_plan");
    const dir = join(TMP, "f_plan", "gbrain-queue");
    const files = await readdir(dir);
    const raw = await readFile(join(dir, files[0]!), "utf8");
    const obj = JSON.parse(raw.trim());
    expect(obj.source_id).toBe("myteam");
  });

  test("multiple emits produce distinct files (no collisions)", async () => {
    for (let i = 0; i < 3; i++) {
      emitPlanCreated({
        flow_id: "f_plan",
        goal: `g-${i}`,
        contract: TINY_CONTRACT,
      });
    }
    await flushGbrain("f_plan");
    const dir = join(TMP, "f_plan", "gbrain-queue");
    const files = await readdir(dir);
    expect(files.length).toBe(3);
  });
});

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { selectAdapter } from "../src/gbrain/adapter.ts";
import { buildPlanCreated } from "../src/gbrain/snapshot.ts";
import { __resetGbrainWarned } from "../src/gbrain/client.ts";
import { __resetOutboxCounters } from "../src/gbrain/outbox.ts";

let TMP: string;
let prevRoot: string | undefined;
let prevMode: string | undefined;
let prevSource: string | undefined;

const TINY_CONTRACT = {
  flow_id: "f_cfg",
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
    `gflow-cfg-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  await mkdir(join(TMP, "f_cfg"), { recursive: true });
  prevRoot = process.env.GFLOW_ROOT;
  prevMode = process.env.GBRAIN_MODE;
  prevSource = process.env.GBRAIN_SOURCE_ID;
  process.env.GFLOW_ROOT = TMP;
  __resetGbrainWarned();
  __resetOutboxCounters();
});

afterEach(async () => {
  if (prevRoot === undefined) delete process.env.GFLOW_ROOT;
  else process.env.GFLOW_ROOT = prevRoot;
  if (prevMode === undefined) delete process.env.GBRAIN_MODE;
  else process.env.GBRAIN_MODE = prevMode;
  if (prevSource === undefined) delete process.env.GBRAIN_SOURCE_ID;
  else process.env.GBRAIN_SOURCE_ID = prevSource;
  await rm(TMP, { recursive: true, force: true });
});

describe("ConfigErrorAdapter — unknown mode", () => {
  test("selectAdapter does not throw on unknown mode", () => {
    process.env.GBRAIN_MODE = "lol";
    const a = selectAdapter();
    expect(a.mode).toBe("off");
  });

  test("health returns ok:false, reason=unknown_mode", async () => {
    process.env.GBRAIN_MODE = "lol";
    const h = await selectAdapter().health();
    expect(h.ok).toBe(false);
    expect(h.reason).toBe("unknown_mode");
    expect(h.detail).toContain("lol");
  });

  test("queryContext returns empty silently (hot path)", async () => {
    process.env.GBRAIN_MODE = "lol";
    const r = await selectAdapter().queryContext("anything");
    expect(r.results.length).toBe(0);
  });

  test("drainOutbox returns ok:false with structured error (explicit action)", async () => {
    process.env.GBRAIN_MODE = "lol";
    const r = await selectAdapter().drainOutbox("f_cfg");
    expect(r.ok).toBe(false);
    expect(r.errors.length).toBe(1);
    expect(r.errors[0]!.message).toContain("GBrain misconfigured");
  });

  test("enqueueSnapshot still writes JSONL outbox even under config error", async () => {
    process.env.GBRAIN_MODE = "lol";
    const a = selectAdapter();
    a.enqueueSnapshot(
      buildPlanCreated({
        flow_id: "f_cfg",
        source_id: "gflow",
        goal: "g",
        contract: TINY_CONTRACT,
      }),
    );
    await a.flush("f_cfg");
    const files = await readdir(join(TMP, "f_cfg", "gbrain-queue"));
    expect(files.length).toBe(1);
  });
});

describe("ConfigErrorAdapter — mcp-http without required env", () => {
  test("missing URL+TOKEN → drainOutbox returns ok:false structured", async () => {
    process.env.GBRAIN_MODE = "mcp-http";
    delete process.env.GBRAIN_HTTP_URL;
    delete process.env.GBRAIN_AUTH_TOKEN;
    const r = await selectAdapter().drainOutbox("f_cfg");
    expect(r.ok).toBe(false);
    expect(r.errors[0]!.message).toContain("GBrain misconfigured");
  });
});

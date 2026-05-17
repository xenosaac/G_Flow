import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { selectAdapter, __setGbrainSpawn, __setGbrainFetch } from "../src/gbrain/adapter.ts";
import { buildPlanCreated } from "../src/gbrain/snapshot.ts";
import { __resetOutboxCounters } from "../src/gbrain/outbox.ts";
import { flushGbrain, __resetGbrainWarned } from "../src/gbrain/client.ts";
import type { SpawnOptions, SpawnResult } from "../src/adapters/spawn.ts";

let TMP: string;
let prevRoot: string | undefined;
let prevEnv: Record<string, string | undefined> = {};
const ENV = ["GBRAIN_MODE", "GBRAIN_HTTP_URL", "GBRAIN_AUTH_TOKEN"];

const TINY = {
  flow_id: "f_nb",
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
    `gflow-nb-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  await mkdir(join(TMP, "f_nb"), { recursive: true });
  prevRoot = process.env.GFLOW_ROOT;
  process.env.GFLOW_ROOT = TMP;
  for (const k of ENV) {
    prevEnv[k] = process.env[k];
    delete process.env[k];
  }
  __resetGbrainWarned();
  __resetOutboxCounters();
});

afterEach(async () => {
  if (prevRoot === undefined) delete process.env.GFLOW_ROOT;
  else process.env.GFLOW_ROOT = prevRoot;
  for (const k of ENV) {
    if (prevEnv[k] === undefined) delete process.env[k];
    else process.env[k] = prevEnv[k];
  }
  prevEnv = {};
  __setGbrainSpawn(undefined);
  __setGbrainFetch(undefined);
  await rm(TMP, { recursive: true, force: true });
});

describe("enqueueSnapshot is synchronous under all modes", () => {
  test("OffAdapter — enqueue returns within 50 ms", () => {
    const a = selectAdapter();
    const t0 = Date.now();
    a.enqueueSnapshot(
      buildPlanCreated({
        flow_id: "f_nb",
        source_id: "gflow",
        goal: "g",
        contract: TINY,
      }),
    );
    expect(Date.now() - t0).toBeLessThan(50);
  });

  test("LocalCliAdapter — enqueue is sync even with a deliberately-slow spawn", () => {
    process.env.GBRAIN_MODE = "local-cli";
    __setGbrainSpawn(
      (_argv: string[], _opts: SpawnOptions): Promise<SpawnResult> =>
        new Promise((resolve) =>
          setTimeout(
            () => resolve({ ok: true, exitCode: 0, stdout: "", stderr: "", timedOut: false }),
            5000,
          ),
        ),
    );
    const a = selectAdapter();
    const t0 = Date.now();
    a.enqueueSnapshot(
      buildPlanCreated({
        flow_id: "f_nb",
        source_id: "gflow",
        goal: "g",
        contract: TINY,
      }),
    );
    // enqueue must return immediately; the snapshot write itself happens later.
    expect(Date.now() - t0).toBeLessThan(50);
  });

  test("McpHttpAdapter — enqueue is sync even with a fetch that hangs", () => {
    process.env.GBRAIN_MODE = "mcp-http";
    process.env.GBRAIN_HTTP_URL = "http://example.test";
    process.env.GBRAIN_AUTH_TOKEN = "tok";
    __setGbrainFetch(
      () =>
        new Promise<Response>(() => {
          /* never resolve */
        }),
    );
    const a = selectAdapter();
    const t0 = Date.now();
    a.enqueueSnapshot(
      buildPlanCreated({
        flow_id: "f_nb",
        source_id: "gflow",
        goal: "g",
        contract: TINY,
      }),
    );
    expect(Date.now() - t0).toBeLessThan(50);
  });
});

describe("durability across flush", () => {
  test("flushGbrain waits for the in-memory chain, files land on disk", async () => {
    const a = selectAdapter();
    for (let i = 0; i < 5; i++) {
      a.enqueueSnapshot(
        buildPlanCreated({
          flow_id: "f_nb",
          source_id: "gflow",
          goal: `g-${i}`,
          contract: TINY,
        }),
      );
    }
    // Before flush, files may or may not be on disk (race window).
    await flushGbrain("f_nb");
    const files = await readdir(join(TMP, "f_nb", "gbrain-queue"));
    expect(files.length).toBe(5);
  });
});

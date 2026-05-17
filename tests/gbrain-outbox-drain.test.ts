import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, rm, writeFile, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { selectAdapter, __setGbrainSpawn } from "../src/gbrain/adapter.ts";
import { buildPlanCreated } from "../src/gbrain/snapshot.ts";
import { __resetOutboxCounters } from "../src/gbrain/outbox.ts";
import { __resetGbrainWarned } from "../src/gbrain/client.ts";
import type { SpawnOptions, SpawnResult } from "../src/adapters/spawn.ts";

let TMP: string;
let prevRoot: string | undefined;
let prevMode: string | undefined;
const FLOW = "f_drain";

const TINY_CONTRACT = {
  flow_id: FLOW,
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

function makeSnapshot(seq: number) {
  const snap = buildPlanCreated({
    flow_id: FLOW,
    source_id: "gflow",
    goal: `goal-${seq}`,
    contract: TINY_CONTRACT,
  });
  return JSON.stringify(snap);
}

beforeEach(async () => {
  TMP = join(
    tmpdir(),
    `gflow-drain-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  await mkdir(join(TMP, FLOW, "gbrain-queue"), { recursive: true });
  prevRoot = process.env.GFLOW_ROOT;
  prevMode = process.env.GBRAIN_MODE;
  process.env.GFLOW_ROOT = TMP;
  process.env.GBRAIN_MODE = "local-cli";
  __resetGbrainWarned();
  __resetOutboxCounters();
});

afterEach(async () => {
  if (prevRoot === undefined) delete process.env.GFLOW_ROOT;
  else process.env.GFLOW_ROOT = prevRoot;
  if (prevMode === undefined) delete process.env.GBRAIN_MODE;
  else process.env.GBRAIN_MODE = prevMode;
  __setGbrainSpawn(undefined);
  await rm(TMP, { recursive: true, force: true });
});

async function drainDir(): Promise<string[]> {
  return (await readdir(join(TMP, FLOW, "gbrain-queue"))).sort();
}

describe("drainOutbox state machine", () => {
  test("empty dir → ok:true, drained:0", async () => {
    __setGbrainSpawn(
      async (): Promise<SpawnResult> => ({ ok: true, exitCode: 0, stdout: "{}", stderr: "", timedOut: false }),
    );
    const r = await selectAdapter().drainOutbox(FLOW);
    expect(r.ok).toBe(true);
    expect(r.drained).toBe(0);
  });

  test("all-success → files renamed to .synced", async () => {
    const dir = join(TMP, FLOW, "gbrain-queue");
    await writeFile(join(dir, "a.jsonl"), makeSnapshot(1) + "\n", "utf8");
    await writeFile(join(dir, "b.jsonl"), makeSnapshot(2) + "\n", "utf8");
    __setGbrainSpawn(
      async (): Promise<SpawnResult> => ({ ok: true, exitCode: 0, stdout: "{}", stderr: "", timedOut: false }),
    );
    const r = await selectAdapter().drainOutbox(FLOW);
    expect(r.ok).toBe(true);
    expect(r.synced).toBe(2);
    const files = await drainDir();
    expect(files.filter((f) => f.endsWith(".synced")).length).toBe(2);
    expect(files.filter((f) => f.endsWith(".jsonl") && !f.endsWith(".synced") && !f.endsWith(".failed")).length).toBe(0);
  });

  test("all-failure → files renamed to .failed + .error.txt", async () => {
    const dir = join(TMP, FLOW, "gbrain-queue");
    await writeFile(join(dir, "a.jsonl"), makeSnapshot(1) + "\n", "utf8");
    __setGbrainSpawn(
      async (): Promise<SpawnResult> => ({ ok: false, exitCode: 1, stdout: "", stderr: "boom", timedOut: false }),
    );
    const r = await selectAdapter().drainOutbox(FLOW);
    expect(r.ok).toBe(false);
    expect(r.failed).toBe(1);
    const files = await drainDir();
    expect(files.some((f) => f === "a.jsonl.failed")).toBe(true);
    expect(files.some((f) => f === "a.jsonl.failed.error.txt")).toBe(true);
  });

  test("second drain retries .failed entries", async () => {
    const dir = join(TMP, FLOW, "gbrain-queue");
    await writeFile(join(dir, "a.jsonl"), makeSnapshot(1) + "\n", "utf8");
    let firstCall = true;
    __setGbrainSpawn(
      async (): Promise<SpawnResult> => {
        if (firstCall) {
          firstCall = false;
          return { ok: false, exitCode: 1, stdout: "", stderr: "transient", timedOut: false };
        }
        return { ok: true, exitCode: 0, stdout: "{}", stderr: "", timedOut: false };
      },
    );
    await selectAdapter().drainOutbox(FLOW);
    const r2 = await selectAdapter().drainOutbox(FLOW);
    expect(r2.synced).toBe(1);
    expect(r2.failed).toBe(0);
    const files = await drainDir();
    expect(files.filter((f) => f.endsWith(".synced")).length).toBe(1);
    expect(files.filter((f) => f.endsWith(".failed")).length).toBe(0);
  });

  test("corrupt JSONL → .failed (not skipped silently)", async () => {
    const dir = join(TMP, FLOW, "gbrain-queue");
    await writeFile(join(dir, "bad.jsonl"), "{not valid json\n", "utf8");
    __setGbrainSpawn(
      async (): Promise<SpawnResult> => ({ ok: true, exitCode: 0, stdout: "{}", stderr: "", timedOut: false }),
    );
    const r = await selectAdapter().drainOutbox(FLOW);
    expect(r.ok).toBe(false);
    expect(r.failed).toBe(1);
    expect(r.errors[0]!.message).toContain("parse error");
  });
});

describe("legacy multi-line JSONL handling", () => {
  test("multi-line legacy file is split into N children; corrupt children fail naturally", async () => {
    const dir = join(TMP, FLOW, "gbrain-queue");
    const goodLines = [makeSnapshot(1), makeSnapshot(2), makeSnapshot(3)];
    const corrupt = "{this is not valid json}";
    // Mix: 3 good + 1 corrupt = 4 non-empty lines.
    const body = [goodLines[0], corrupt, goodLines[1], goodLines[2]].join("\n") + "\n";
    await writeFile(join(dir, "legacy.jsonl"), body, "utf8");

    __setGbrainSpawn(
      async (): Promise<SpawnResult> => ({ ok: true, exitCode: 0, stdout: "{}", stderr: "", timedOut: false }),
    );

    const r = await selectAdapter().drainOutbox(FLOW);
    expect(r.drained).toBe(4); // split into 4 single-line children
    expect(r.synced).toBe(3);
    expect(r.failed).toBe(1);

    const files = await drainDir();
    // Original renamed to legacy-consumed.
    expect(files.some((f) => f.endsWith(".legacy-consumed"))).toBe(true);
    // Children appear with .synced or .failed suffixes.
    const splitSynced = files.filter((f) => f.includes(".split.") && f.endsWith(".synced"));
    const splitFailed = files.filter((f) => f.includes(".split.") && f.endsWith(".failed"));
    expect(splitSynced.length).toBe(3);
    expect(splitFailed.length).toBe(1);
  });

  test("second drain is a no-op on .legacy-consumed (idempotent split)", async () => {
    const dir = join(TMP, FLOW, "gbrain-queue");
    await writeFile(join(dir, "legacy.jsonl"), makeSnapshot(1) + "\n" + makeSnapshot(2) + "\n", "utf8");
    __setGbrainSpawn(
      async (): Promise<SpawnResult> => ({ ok: true, exitCode: 0, stdout: "{}", stderr: "", timedOut: false }),
    );
    await selectAdapter().drainOutbox(FLOW);
    const r2 = await selectAdapter().drainOutbox(FLOW);
    expect(r2.drained).toBe(0);
  });
});

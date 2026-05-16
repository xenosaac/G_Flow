import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runWorker, parseHandoff, writeHandoff } from "../src/runtime/worker.ts";
import { MockBackend } from "../src/adapters/mock.ts";
import type { FeatureT } from "../src/artifacts/contract.ts";

const feature: FeatureT = {
  id: "F-001",
  title: "Signup endpoint",
  spec: "POST /api/auth/signup returns 201 with token",
  assertions: [
    {
      id: "A-001-001",
      text: "POST returns 201",
      validator: "screwdriver",
      evidence_required: "HTTP capture",
      status: "pending",
      origin: "original",
      attempts: [],
    },
  ],
};

const goodHandoffJson = {
  feature_id: "F-001",
  flow_id: "f_test_0001",
  completed: true,
  files_touched: ["src/api/signup.ts"],
  commands_run: [{ cmd: "bun test", exit_code: 0, stdout_tail: "ok", stderr_tail: "" }],
  assertions_attempted: ["A-001-001"],
  deviations: "",
  next_worker_hints: "",
  recorded_at: "2026-05-16T11:00:00.000Z",
};

describe("parseHandoff", () => {
  test("extracts JSON inside ```json fences", () => {
    const raw = `I built the thing.\n\n\`\`\`json\n${JSON.stringify(goodHandoffJson)}\n\`\`\`\n`;
    const h = parseHandoff(raw, { flow_id: "f_test_0001", feature_id: "F-001" });
    expect(h.completed).toBe(true);
    expect(h.files_touched).toEqual(["src/api/signup.ts"]);
  });

  test("extracts trailing balanced JSON without fences", () => {
    const raw = `Some prose.\n\n${JSON.stringify(goodHandoffJson)}\n`;
    const h = parseHandoff(raw, { flow_id: "f_test_0001", feature_id: "F-001" });
    expect(h.completed).toBe(true);
  });

  test("fills sensible defaults when no JSON is present", () => {
    const h = parseHandoff("I gave up halfway through.", {
      flow_id: "f_test_0001",
      feature_id: "F-001",
    });
    expect(h.completed).toBe(false);
    expect(h.feature_id).toBe("F-001");
    expect(h.flow_id).toBe("f_test_0001");
  });

  test("picks the LAST balanced JSON object when multiple appear", () => {
    const earlier = { feature_id: "F-001", flow_id: "x", completed: false, recorded_at: "x" };
    const raw = `${JSON.stringify(earlier)}\n... and then\n${JSON.stringify(goodHandoffJson)}\n`;
    const h = parseHandoff(raw, { flow_id: "f_test_0001", feature_id: "F-001" });
    expect(h.completed).toBe(true);
  });
});

describe("runWorker", () => {
  test("returns parsed handoff when backend succeeds", async () => {
    const backend = new MockBackend(() => ({
      stdout: "```json\n" + JSON.stringify(goodHandoffJson) + "\n```",
    }));
    const r = await runWorker({
      flow_id: "f_test_0001",
      feature,
      milestone_id: "M-001",
      target_dir: "/tmp/x",
      backend,
      attempt: 1,
      timeoutMs: 1000,
      maxRetries: 0,
    });
    expect(r.handoff.completed).toBe(true);
    expect(r.attemptsUsed).toBe(1);
    expect(backend.calls).toHaveLength(1);
    expect(backend.calls[0]!.role).toBe("worker");
    expect(backend.calls[0]!.prompt).toContain("A-001-001");
    expect(backend.calls[0]!.prompt).toContain("/tmp/x");
  });

  test("retries on backend failure then succeeds", async () => {
    let n = 0;
    const backend = new MockBackend(() => {
      n++;
      if (n === 1) {
        return { stdout: "", stderr: "boom", ok: false, exitCode: 1 };
      }
      return { stdout: "```json\n" + JSON.stringify(goodHandoffJson) + "\n```" };
    });
    const r = await runWorker({
      flow_id: "f_test_0001",
      feature,
      milestone_id: "M-001",
      target_dir: "/tmp/x",
      backend,
      attempt: 1,
      timeoutMs: 1000,
      maxRetries: 2,
      backoffsMs: [0, 0],
    });
    expect(r.attemptsUsed).toBe(2);
    expect(r.handoff.completed).toBe(true);
  });

  test("throws after retries are exhausted", async () => {
    const backend = new MockBackend(() => ({
      stdout: "",
      stderr: "still broken",
      ok: false,
      exitCode: 1,
    }));
    await expect(
      runWorker({
        flow_id: "f_test_0001",
        feature,
        milestone_id: "M-001",
        target_dir: "/tmp/x",
        backend,
        attempt: 1,
        timeoutMs: 1000,
        maxRetries: 1,
        backoffsMs: [0],
      }),
    ).rejects.toThrow(/worker failed after 2 attempts/);
    expect(backend.calls).toHaveLength(2);
  });

  test("injects a corrective_block when failures are provided", async () => {
    const backend = new MockBackend(() => ({
      stdout: "```json\n" + JSON.stringify(goodHandoffJson) + "\n```",
    }));
    await runWorker({
      flow_id: "f_test_0001",
      feature,
      milestone_id: "M-001",
      target_dir: "/tmp/x",
      backend,
      attempt: 3,
      failures: [
        { assertion_id: "A-001-002", outcome: "fail", detail: "stale UI" },
      ],
      timeoutMs: 1000,
      maxRetries: 0,
    });
    expect(backend.calls[0]!.prompt).toContain("Corrective context (attempt 3)");
    expect(backend.calls[0]!.prompt).toContain("A-001-002");
  });
});

describe("writeHandoff", () => {
  let TMP: string;
  beforeEach(async () => {
    TMP = join(tmpdir(), `gflow-handoff-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    await mkdir(TMP, { recursive: true });
  });
  afterEach(async () => {
    await rm(TMP, { recursive: true, force: true });
  });

  test("writes a handoff atomically to handoffs/<id>__attempt-NN.json", async () => {
    const h = parseHandoff(JSON.stringify(goodHandoffJson), {
      flow_id: "f_test_0001",
      feature_id: "F-001",
    });
    const p = await writeHandoff(h, TMP, 1);
    expect(p.endsWith("F-001__attempt-01.json")).toBe(true);
    const raw = await readFile(p, "utf8");
    expect(JSON.parse(raw).completed).toBe(true);
  });
});

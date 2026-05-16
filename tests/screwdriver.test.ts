import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runScrewdriver, writeScrewdriverReport, type ProjectCheckResult } from "../src/runtime/validators/screwdriver.ts";
import type { FeatureT } from "../src/artifacts/contract.ts";

const feature: FeatureT = {
  id: "F-001",
  title: "Signup",
  spec: "POST /api/auth/signup",
  assertions: [
    {
      id: "A-001-001",
      text: "POST /signup returns 201",
      validator: "screwdriver",
      evidence_required: "HTTP capture",
      status: "pending",
      origin: "original",
      attempts: [],
    },
    {
      id: "A-001-002",
      text: "Form redirects to /dashboard",
      validator: "user-test",
      evidence_required: "screenshot",
      status: "pending",
      origin: "original",
      attempts: [],
    },
  ],
};

const okCheck = (cmd: string): ProjectCheckResult => ({
  cmd,
  exitCode: 0,
  stdoutTail: "all pass",
  stderrTail: "",
  timedOut: false,
});

const failCheck = (cmd: string, exit: number): ProjectCheckResult => ({
  cmd,
  exitCode: exit,
  stdoutTail: "FAIL: 1 test failed",
  stderrTail: "x.ts:12 expected 1 got 2",
  timedOut: false,
});

describe("runScrewdriver", () => {
  test("all checks pass → status='pass', only screwdriver assertions appear", async () => {
    const r = await runScrewdriver({
      flow_id: "f_test_0001",
      feature,
      target_dir: "/tmp/anywhere",
      runner: async () => [okCheck("bun test"), okCheck("tsc --noEmit")],
    });
    expect(r.status).toBe("pass");
    expect(r.assertion_results).toHaveLength(1);
    expect(r.assertion_results[0]!.assertion_id).toBe("A-001-001");
    expect(r.assertion_results[0]!.outcome).toBe("pass");
    expect(r.validator).toBe("screwdriver");
    expect(r.steward_hint).toBe("NONE");
  });

  test("any failing check → status='fail', screwdriver assertions marked fail", async () => {
    const r = await runScrewdriver({
      flow_id: "f_test_0001",
      feature,
      target_dir: "/tmp/anywhere",
      runner: async () => [okCheck("tsc --noEmit"), failCheck("bun test", 1)],
    });
    expect(r.status).toBe("fail");
    expect(r.assertion_results[0]!.outcome).toBe("fail");
    expect(r.raw_stdout_tail).toContain("bun test");
  });

  test("timeout (exitCode=null) is treated as failure", async () => {
    const r = await runScrewdriver({
      flow_id: "f_test_0001",
      feature,
      target_dir: "/tmp/anywhere",
      runner: async () => [
        { cmd: "bun test", exitCode: null, stdoutTail: "", stderrTail: "", timedOut: true },
      ],
    });
    expect(r.status).toBe("fail");
    expect(r.assertion_results[0]!.outcome).toBe("fail");
    expect(r.assertion_results[0]!.detail).toContain("killed");
  });

  test("missing target_dir → fail (default runner)", async () => {
    const r = await runScrewdriver({
      flow_id: "f_test_0001",
      feature,
      target_dir: "/this/should/not/exist/" + Date.now(),
    });
    expect(r.status).toBe("fail");
  });
});

describe("writeScrewdriverReport", () => {
  let TMP: string;
  beforeEach(async () => {
    TMP = join(tmpdir(), `gflow-screwdriver-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    await mkdir(TMP, { recursive: true });
  });
  afterEach(async () => {
    await rm(TMP, { recursive: true, force: true });
  });

  test("writes a screwdriver report atomically", async () => {
    const r = await runScrewdriver({
      flow_id: "f_test_0001",
      feature,
      target_dir: "/tmp/x",
      runner: async () => [okCheck("bun test")],
    });
    const p = await writeScrewdriverReport(r, TMP, 1);
    expect(p.endsWith("F-001__screwdriver__attempt-01.json")).toBe(true);
    const raw = await readFile(p, "utf8");
    expect(JSON.parse(raw).validator).toBe("screwdriver");
  });
});

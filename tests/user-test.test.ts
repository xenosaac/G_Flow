import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runUserTest, writeUserTestReport } from "../src/runtime/validators/user-test.ts";
import type { FeatureT } from "../src/artifacts/contract.ts";

const feature: FeatureT = {
  id: "F-001",
  title: "Signup",
  spec: "POST /api/auth/signup",
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
    {
      id: "A-001-002",
      text: "Form redirects to /dashboard",
      validator: "user-test",
      evidence_required: "screenshot",
      status: "pending",
      origin: "original",
      attempts: [],
    },
    {
      id: "A-001-003",
      text: "Dashboard shows username",
      validator: "user-test",
      evidence_required: "screenshot",
      status: "pending",
      origin: "original",
      attempts: [],
    },
  ],
};

describe("G2: user-test subprocess outcome → report.status", () => {
  test("exit 0 + good JSON → assertions parsed per result", async () => {
    const r = await runUserTest({
      flow_id: "f_test_0001",
      feature,
      target_dir: "/tmp",
      target_url: "http://localhost:3000",
      runner: async () => ({
        exitCode: 0,
        stdout: JSON.stringify({
          results: [
            { assertion_id: "A-001-002", outcome: "pass", detail: "ok", evidence: "shot1.png" },
            { assertion_id: "A-001-003", outcome: "fail", detail: "username missing" },
          ],
        }),
        stderr: "",
        timedOut: false,
      }),
    });
    expect(r.status).toBe("fail");
    expect(r.assertion_results).toHaveLength(2);
    expect(r.assertion_results[0]).toEqual({
      assertion_id: "A-001-002",
      outcome: "pass",
      detail: "ok",
      evidence: "shot1.png",
    });
    expect(r.assertion_results[1]!.outcome).toBe("fail");
    expect(r.steward_hint).toBe("NONE");
  });

  test("exit 0 + all passing → status='pass'", async () => {
    const r = await runUserTest({
      flow_id: "f_test_0001",
      feature,
      target_dir: "/tmp",
      target_url: "http://localhost:3000",
      runner: async () => ({
        exitCode: 0,
        stdout: JSON.stringify({
          results: [
            { assertion_id: "A-001-002", outcome: "pass" },
            { assertion_id: "A-001-003", outcome: "pass" },
          ],
        }),
        stderr: "",
        timedOut: false,
      }),
    });
    expect(r.status).toBe("pass");
  });

  test("G2: exit !=0 → status='tool_error', steward_hint='INFRA', NO assertions marked fail", async () => {
    const r = await runUserTest({
      flow_id: "f_test_0001",
      feature,
      target_dir: "/tmp",
      target_url: "http://localhost:3000",
      runner: async () => ({
        exitCode: 3,
        stdout: "",
        stderr: "browser-use not importable: No module named 'browser_use'",
        timedOut: false,
      }),
    });
    expect(r.status).toBe("tool_error");
    expect(r.steward_hint).toBe("INFRA");
    expect(r.assertion_results).toEqual([]);
    expect(r.raw_stderr_tail).toContain("nonzero_exit(3)");
  });

  test("G2: subprocess timeout → status='tool_error', INFRA", async () => {
    const r = await runUserTest({
      flow_id: "f_test_0001",
      feature,
      target_dir: "/tmp",
      target_url: "http://localhost:3000",
      runner: async () => ({
        exitCode: null,
        stdout: "",
        stderr: "",
        timedOut: true,
      }),
    });
    expect(r.status).toBe("tool_error");
    expect(r.steward_hint).toBe("INFRA");
    expect(r.raw_stderr_tail).toContain("timed_out");
  });

  test("G2: exit 0 but stdout is not JSON → status='tool_error', INFRA (do NOT fake pass/fail)", async () => {
    const r = await runUserTest({
      flow_id: "f_test_0001",
      feature,
      target_dir: "/tmp",
      target_url: "http://localhost:3000",
      runner: async () => ({
        exitCode: 0,
        stdout: "this is not json",
        stderr: "",
        timedOut: false,
      }),
    });
    expect(r.status).toBe("tool_error");
    expect(r.steward_hint).toBe("INFRA");
    expect(r.assertion_results).toEqual([]);
  });

  test("G2: exit 0 + JSON missing results array → tool_error / INFRA", async () => {
    const r = await runUserTest({
      flow_id: "f_test_0001",
      feature,
      target_dir: "/tmp",
      target_url: "http://localhost:3000",
      runner: async () => ({
        exitCode: 0,
        stdout: JSON.stringify({ ok: true }),
        stderr: "",
        timedOut: false,
      }),
    });
    expect(r.status).toBe("tool_error");
    expect(r.steward_hint).toBe("INFRA");
  });

  test("missing result for one assertion → that one marks fail, status='fail'", async () => {
    const r = await runUserTest({
      flow_id: "f_test_0001",
      feature,
      target_dir: "/tmp",
      target_url: "http://localhost:3000",
      runner: async () => ({
        exitCode: 0,
        stdout: JSON.stringify({
          results: [{ assertion_id: "A-001-002", outcome: "pass" }],
        }),
        stderr: "",
        timedOut: false,
      }),
    });
    expect(r.status).toBe("fail");
    const a3 = r.assertion_results.find((x) => x.assertion_id === "A-001-003");
    expect(a3?.outcome).toBe("fail");
    expect(a3?.detail).toContain("did not report");
  });

  test("filters out screwdriver assertions (only user-test ones reported)", async () => {
    const r = await runUserTest({
      flow_id: "f_test_0001",
      feature,
      target_dir: "/tmp",
      target_url: "http://localhost:3000",
      runner: async () => ({
        exitCode: 0,
        stdout: JSON.stringify({
          results: [
            { assertion_id: "A-001-002", outcome: "pass" },
            { assertion_id: "A-001-003", outcome: "pass" },
          ],
        }),
        stderr: "",
        timedOut: false,
      }),
    });
    expect(r.assertion_results.find((x) => x.assertion_id === "A-001-001")).toBeUndefined();
    expect(r.assertion_results).toHaveLength(2);
  });

  test("runner throws → tool_error / INFRA", async () => {
    const r = await runUserTest({
      flow_id: "f_test_0001",
      feature,
      target_dir: "/tmp",
      target_url: "http://localhost:3000",
      runner: async () => {
        throw new Error("ENOENT: python3 not found");
      },
    });
    expect(r.status).toBe("tool_error");
    expect(r.steward_hint).toBe("INFRA");
    expect(r.raw_stderr_tail).toContain("ENOENT");
  });
});

describe("writeUserTestReport", () => {
  let TMP: string;
  beforeEach(async () => {
    TMP = join(tmpdir(), `gflow-usertest-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    await mkdir(TMP, { recursive: true });
  });
  afterEach(async () => {
    await rm(TMP, { recursive: true, force: true });
  });

  test("writes report atomically to disk", async () => {
    const r = await runUserTest({
      flow_id: "f_test_0001",
      feature,
      target_dir: "/tmp",
      target_url: "http://localhost:3000",
      runner: async () => ({
        exitCode: 0,
        stdout: JSON.stringify({
          results: [{ assertion_id: "A-001-002", outcome: "pass" }, { assertion_id: "A-001-003", outcome: "pass" }],
        }),
        stderr: "",
        timedOut: false,
      }),
    });
    const p = await writeUserTestReport(r, TMP, 1);
    expect(p.endsWith("F-001__usertest__attempt-01.json")).toBe(true);
    const back = JSON.parse(await readFile(p, "utf8"));
    expect(back.validator).toBe("user-test");
    expect(back.status).toBe("pass");
  });
});

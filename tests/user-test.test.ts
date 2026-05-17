import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, rm, readFile, writeFile } from "node:fs/promises";
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
      user_check: {
        kind: "browser_flow",
        start: "target_url",
        steps: [{ kind: "expect_url", contains: "localhost" }],
      },
      status: "pending",
      origin: "original",
      attempts: [],
    },
    {
      id: "A-001-003",
      text: "Dashboard shows username",
      validator: "user-test",
      evidence_required: "screenshot",
      user_check: {
        kind: "browser_flow",
        start: "target_url",
        steps: [{ kind: "expect_url", contains: "localhost" }],
      },
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
        stderr: "Playwright not importable: Cannot find module 'playwright'",
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

  test("G2: assertion-level tool_error escalates whole report to tool_error/INFRA", async () => {
    // Browser runner exited 0 and returned JSON, but the runner
    // self-reported "tool_error" per assertion (e.g. captcha, rate limit).
    // The OLD bug: this would map to assertion.outcome=tool_error but report
    // status would be "pass" (because the only fail check was r.outcome==="fail").
    // A Steward seeing status=pass would advance the feature; a corrective
    // Worker would never run, and we'd silently mask infrastructure failures.
    const r = await runUserTest({
      flow_id: "f_test_0001",
      feature,
      target_dir: "/tmp",
      target_url: "http://localhost:3000",
      runner: async () => ({
        exitCode: 0,
        stdout: JSON.stringify({
          results: [
            { assertion_id: "A-001-002", outcome: "tool_error", detail: "browser launch failed" },
            { assertion_id: "A-001-003", outcome: "pass", detail: "ok" },
          ],
        }),
        stderr: "",
        timedOut: false,
      }),
    });
    expect(r.status).toBe("tool_error");
    expect(r.steward_hint).toBe("INFRA");
    expect(r.assertion_results).toHaveLength(2);
    expect(r.assertion_results[0]!.outcome).toBe("tool_error");
    expect(r.assertion_results[1]!.outcome).toBe("pass");
  });

  test("G2: tool_error wins over fail in mixed outcomes", async () => {
    // If the browser runner reports one tool_error and one fail, treat the WHOLE
    // report as tool_error. Otherwise Steward would route BROKEN_IMPL on the
    // fail, when the upstream tool was actually broken.
    const r = await runUserTest({
      flow_id: "f_test_0001",
      feature,
      target_dir: "/tmp",
      target_url: "http://localhost:3000",
      runner: async () => ({
        exitCode: 0,
        stdout: JSON.stringify({
          results: [
            { assertion_id: "A-001-002", outcome: "fail", detail: "form did not submit" },
            { assertion_id: "A-001-003", outcome: "tool_error", detail: "page never loaded" },
          ],
        }),
        stderr: "",
        timedOut: false,
      }),
    });
    expect(r.status).toBe("tool_error");
    expect(r.steward_hint).toBe("INFRA");
  });

  test("G2: all per-assertion outcomes are pass → status='pass' (no false INFRA)", async () => {
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
    expect(r.steward_hint).toBe("NONE");
  });
});

describe("playwright-user-test.ts deterministic browser contract", () => {
  let TMP: string;
  beforeEach(async () => {
    TMP = join(tmpdir(), `gflow-playwright-usertest-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    await mkdir(TMP, { recursive: true });
  });
  afterEach(async () => {
    await rm(TMP, { recursive: true, force: true });
  });

  test("static todo app passes real Chromium fill/click/text checks", async () => {
    await writeFile(
      join(TMP, "index.html"),
      `<!doctype html><html><body>
        <input id="todo-input">
        <button id="add-todo">Add Todo</button>
        <ul id="todo-list"></ul>
        <script>
          document.getElementById('add-todo').addEventListener('click', () => {
            const input = document.getElementById('todo-input');
            const value = input.value.trim();
            if (!value) return;
            const li = document.createElement('li');
            li.textContent = value;
            document.getElementById('todo-list').appendChild(li);
            input.value = '';
          });
        </script>
      </body></html>`,
      "utf8",
    );
    const r = await runUserTest({
      flow_id: "f_test_0001",
      feature: {
        ...feature,
        assertions: [
          {
            id: "A-REAL-001",
            text: "Typing Buy milk and clicking Add Todo appends Buy milk",
            validator: "user-test",
            evidence_required: "Chromium DOM observation",
            user_check: {
              kind: "browser_flow",
              start: "file",
              path: "index.html",
              steps: [
                { kind: "fill", selector: "#todo-input", value: "Buy milk" },
                { kind: "click", selector: "#add-todo" },
                { kind: "expect_text", selector: "#todo-list", text: "Buy milk" },
              ],
              timeout_ms: 5000,
            },
            status: "pending",
            origin: "original",
            attempts: [],
          },
        ],
      },
      target_dir: TMP,
      target_url: "http://localhost:3000",
      timeoutMs: 20_000,
    });
    expect(r.status).toBe("pass");
    expect(r.assertion_results[0]!.outcome).toBe("pass");
  });

  test("broken DOM selector fails the user-test assertion, not fake pass", async () => {
    await writeFile(join(TMP, "index.html"), "<div id='app'>empty</div>", "utf8");
    const r = await runUserTest({
      flow_id: "f_test_0001",
      feature: {
        ...feature,
        assertions: [
          {
            id: "A-REAL-002",
            text: "Clicking missing add button should append an item",
            validator: "user-test",
            evidence_required: "Chromium DOM observation",
            user_check: {
              kind: "browser_flow",
              start: "file",
              path: "index.html",
              steps: [
                { kind: "click", selector: "#missing-button" },
                { kind: "expect_text", selector: "#todo-list", text: "Buy milk" },
              ],
              timeout_ms: 1000,
            },
            status: "pending",
            origin: "original",
            attempts: [],
          },
        ],
      },
      target_dir: TMP,
      target_url: "http://localhost:3000",
      timeoutMs: 20_000,
    });
    expect(r.status).toBe("fail");
    expect(r.assertion_results[0]!.outcome).toBe("fail");
    expect(r.assertion_results[0]!.detail).toContain("#missing-button");
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

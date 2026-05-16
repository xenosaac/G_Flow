import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runCheck } from "../src/runtime/validators/checks.ts";
import { runScrewdriver } from "../src/runtime/validators/screwdriver.ts";
import type { FeatureT } from "../src/artifacts/contract.ts";

let TMP: string;

beforeEach(async () => {
  TMP = join(
    tmpdir(),
    `gflow-checks-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  await mkdir(TMP, { recursive: true });
});

afterEach(async () => {
  await rm(TMP, { recursive: true, force: true });
});

describe("runCheck — file_exists", () => {
  test("pass when file exists in target_dir", async () => {
    await writeFile(join(TMP, "index.html"), "<html></html>", "utf8");
    const r = await runCheck(TMP, { kind: "file_exists", path: "index.html" });
    expect(r.ok).toBe(true);
    expect(r.detail).toContain("exists");
  });

  test("fail when file does not exist", async () => {
    const r = await runCheck(TMP, { kind: "file_exists", path: "missing.html" });
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("does not exist");
  });

  test("rejects absolute paths", async () => {
    const r = await runCheck(TMP, { kind: "file_exists", path: "/etc/passwd" });
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/escapes target_dir/);
  });

  test("rejects paths that escape target_dir via ..", async () => {
    const r = await runCheck(TMP, { kind: "file_exists", path: "../../../etc/passwd" });
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/escapes target_dir/);
  });
});

describe("runCheck — file_contains", () => {
  test("pass when file contains the substring verbatim", async () => {
    await writeFile(
      join(TMP, "app.js"),
      "function addTodo() { return 'Buy milk'; }",
      "utf8",
    );
    const r = await runCheck(TMP, {
      kind: "file_contains",
      path: "app.js",
      substring: "function addTodo()",
    });
    expect(r.ok).toBe(true);
  });

  test("fail when substring is missing", async () => {
    await writeFile(join(TMP, "app.js"), "console.log('hi');", "utf8");
    const r = await runCheck(TMP, {
      kind: "file_contains",
      path: "app.js",
      substring: "addTodo",
    });
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/does NOT contain/);
  });

  test("fail when path does not exist", async () => {
    const r = await runCheck(TMP, {
      kind: "file_contains",
      path: "missing.js",
      substring: "anything",
    });
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/cannot read/);
  });
});

describe("runCheck — command", () => {
  test("pass when command exits 0", async () => {
    const r = await runCheck(TMP, {
      kind: "command",
      cmd: ["true"],
    });
    expect(r.ok).toBe(true);
    expect(r.detail).toMatch(/exit=0/);
  });

  test("fail when command exits nonzero", async () => {
    const r = await runCheck(TMP, {
      kind: "command",
      cmd: ["false"],
    });
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/exit=1/);
  });

  test("command with expected_exit_code=42 passes when exit matches", async () => {
    const r = await runCheck(TMP, {
      kind: "command",
      cmd: ["sh", "-c", "exit 42"],
      expected_exit_code: 42,
    });
    expect(r.ok).toBe(true);
  });

  test("command timing out is reported", async () => {
    const r = await runCheck(TMP, {
      kind: "command",
      cmd: ["sleep", "5"],
      timeout_ms: 200,
    });
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/timed out/);
  });

  test("command with empty cmd array fails", async () => {
    const r = await runCheck(TMP, {
      kind: "command",
      cmd: [],
    } as never);
    // Zod minimum length 1, so this would actually fail Zod parsing earlier.
    // This direct call tests the runtime guard.
    expect(r.ok).toBe(false);
  });
});

describe("runScrewdriver — per-assertion checks", () => {
  test("static HTML project (no tests, no tsc) passes file_exists checks", async () => {
    await writeFile(join(TMP, "index.html"), "<html></html>", "utf8");
    const feature: FeatureT = {
      id: "F-001",
      title: "Static page",
      spec: "index.html exists",
      assertions: [
        {
          id: "A-001-001",
          text: "index.html exists in target_dir",
          validator: "screwdriver",
          evidence_required: "ls",
          status: "pending",
          origin: "original",
          attempts: [],
          check: { kind: "file_exists", path: "index.html" },
        },
      ],
    };
    const r = await runScrewdriver({
      flow_id: "f_test_0001",
      feature,
      target_dir: TMP,
    });
    expect(r.status).toBe("pass");
    expect(r.assertion_results).toHaveLength(1);
    expect(r.assertion_results[0]!.outcome).toBe("pass");
  });

  test("file_exists check fails when path missing → assertion fails", async () => {
    const feature: FeatureT = {
      id: "F-001",
      title: "x",
      spec: "x",
      assertions: [
        {
          id: "A-001-001",
          text: "main.js exists",
          validator: "screwdriver",
          evidence_required: "ls",
          status: "pending",
          origin: "original",
          attempts: [],
          check: { kind: "file_exists", path: "main.js" },
        },
      ],
    };
    const r = await runScrewdriver({
      flow_id: "f_test_0001",
      feature,
      target_dir: TMP,
    });
    expect(r.status).toBe("fail");
    expect(r.assertion_results[0]!.outcome).toBe("fail");
  });

  test("mixed: one passing check + one failing check → status='fail'", async () => {
    await writeFile(join(TMP, "good.html"), "<html></html>", "utf8");
    const feature: FeatureT = {
      id: "F-001",
      title: "x",
      spec: "x",
      assertions: [
        {
          id: "A-001-001",
          text: "good.html exists",
          validator: "screwdriver",
          evidence_required: "ls",
          status: "pending",
          origin: "original",
          attempts: [],
          check: { kind: "file_exists", path: "good.html" },
        },
        {
          id: "A-001-002",
          text: "missing.html exists",
          validator: "screwdriver",
          evidence_required: "ls",
          status: "pending",
          origin: "original",
          attempts: [],
          check: { kind: "file_exists", path: "missing.html" },
        },
      ],
    };
    const r = await runScrewdriver({
      flow_id: "f_test_0001",
      feature,
      target_dir: TMP,
    });
    expect(r.status).toBe("fail");
    expect(r.assertion_results[0]!.outcome).toBe("pass");
    expect(r.assertion_results[1]!.outcome).toBe("fail");
  });

  test("file_contains check covers exact substring match", async () => {
    await writeFile(
      join(TMP, "app.js"),
      "<button id=\"add-todo\">Add Todo</button>",
      "utf8",
    );
    const feature: FeatureT = {
      id: "F-001",
      title: "x",
      spec: "x",
      assertions: [
        {
          id: "A-001-001",
          text: "app.js declares the Add Todo button",
          validator: "screwdriver",
          evidence_required: "src grep",
          status: "pending",
          origin: "original",
          attempts: [],
          check: { kind: "file_contains", path: "app.js", substring: "Add Todo" },
        },
      ],
    };
    const r = await runScrewdriver({
      flow_id: "f_test_0001",
      feature,
      target_dir: TMP,
    });
    expect(r.assertion_results[0]!.outcome).toBe("pass");
  });

  test("no project tests + no tsc + no per-assertion check → still passes (benefit of doubt)", async () => {
    // The pre-fix bug: `bun test` would fail because no test script existed
    // and that error would mark every screwdriver assertion as failed. Now
    // the runner skips inapplicable checks and gives benefit of doubt when
    // no explicit `check` is provided.
    const feature: FeatureT = {
      id: "F-001",
      title: "x",
      spec: "x",
      assertions: [
        {
          id: "A-001-001",
          text: "some legacy assertion without a check",
          validator: "screwdriver",
          evidence_required: "x",
          status: "pending",
          origin: "original",
          attempts: [],
        },
      ],
    };
    const r = await runScrewdriver({
      flow_id: "f_test_0001",
      feature,
      target_dir: TMP,
    });
    expect(r.status).toBe("pass");
    expect(r.assertion_results[0]!.outcome).toBe("pass");
    expect(r.assertion_results[0]!.detail).toMatch(/benefit of doubt/);
  });

  test("legacy fallback: project tests run, all pass → uncovered assertions pass", async () => {
    // mixed: one assertion has a check, one doesn't; project tests pass.
    await writeFile(join(TMP, "x.html"), "x", "utf8");
    const feature: FeatureT = {
      id: "F-001",
      title: "x",
      spec: "x",
      assertions: [
        {
          id: "A-001-001",
          text: "x.html exists",
          validator: "screwdriver",
          evidence_required: "ls",
          status: "pending",
          origin: "original",
          attempts: [],
          check: { kind: "file_exists", path: "x.html" },
        },
        {
          id: "A-001-002",
          text: "legacy assertion no check",
          validator: "screwdriver",
          evidence_required: "x",
          status: "pending",
          origin: "original",
          attempts: [],
        },
      ],
    };
    const r = await runScrewdriver({
      flow_id: "f_test_0001",
      feature,
      target_dir: TMP,
      runner: async () => [
        { cmd: "bun test", exitCode: 0, stdoutTail: "ok", stderrTail: "", timedOut: false, applicable: true },
      ],
    });
    expect(r.status).toBe("pass");
    expect(r.assertion_results).toHaveLength(2);
  });

  test("legacy fallback: project tests fail → uncovered assertion fails (but checked one still passes)", async () => {
    await writeFile(join(TMP, "x.html"), "x", "utf8");
    const feature: FeatureT = {
      id: "F-001",
      title: "x",
      spec: "x",
      assertions: [
        {
          id: "A-001-001",
          text: "x.html exists",
          validator: "screwdriver",
          evidence_required: "ls",
          status: "pending",
          origin: "original",
          attempts: [],
          check: { kind: "file_exists", path: "x.html" },
        },
        {
          id: "A-001-002",
          text: "legacy",
          validator: "screwdriver",
          evidence_required: "x",
          status: "pending",
          origin: "original",
          attempts: [],
        },
      ],
    };
    const r = await runScrewdriver({
      flow_id: "f_test_0001",
      feature,
      target_dir: TMP,
      runner: async () => [
        { cmd: "bun test", exitCode: 1, stdoutTail: "fail", stderrTail: "err", timedOut: false, applicable: true },
      ],
    });
    expect(r.status).toBe("fail");
    const byId = new Map(r.assertion_results.map((a) => [a.assertion_id, a]));
    expect(byId.get("A-001-001")?.outcome).toBe("pass");
    expect(byId.get("A-001-002")?.outcome).toBe("fail");
  });
});

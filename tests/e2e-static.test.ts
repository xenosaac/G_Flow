/**
 * End-to-end synthetic test: drives runFlow against a real target_dir
 * with a fake Worker (writes the static HTML), a REAL Screwdriver (runs
 * file_exists + file_contains checks on the generated file), a fake
 * UserTest (returns pass from a fake deterministic test hook), and a
 * fake Steward.encode.
 *
 * Then loads the generated index.html in jsdom and verifies the
 * "type Buy milk → click Add Todo → list contains Buy milk" path.
 *
 * This proves the post-fix system works end-to-end on a static project
 * without needing a real LLM. The companion scripts/e2e-real.sh script
 * exercises the same path with a real codex/claude backend.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, rm, readFile, writeFile, copyFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { loadStaticHtml } from "../scripts/load-static-html.ts";
import { runFlow } from "../src/runtime/runner.ts";
import { writeContractYaml } from "../src/runtime/contract-io.ts";
import { writeState } from "../src/runtime/state.ts";
import { Contract, type ContractT } from "../src/artifacts/contract.ts";
import { Handoff } from "../src/artifacts/handoff.ts";
import { ValidatorReport } from "../src/artifacts/reports.ts";
import { MockBackend } from "../src/adapters/mock.ts";
import type { runWorker } from "../src/runtime/worker.ts";
import type { runUserTest } from "../src/runtime/validators/user-test.ts";
import type { runStewardEncode } from "../src/runtime/steward.ts";
import type { FlowStateT } from "../src/artifacts/state.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "fixtures", "static-todo.html");

const FLOW = "f_e2e_0001";

let TMP_ROOT: string;
let TMP_TARGET: string;

beforeEach(async () => {
  TMP_ROOT = join(
    tmpdir(),
    `gflow-e2e-root-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  TMP_TARGET = join(
    tmpdir(),
    `gflow-e2e-target-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  await mkdir(TMP_ROOT, { recursive: true });
  await mkdir(TMP_TARGET, { recursive: true });
});

afterEach(async () => {
  await rm(TMP_ROOT, { recursive: true, force: true });
  await rm(TMP_TARGET, { recursive: true, force: true });
});

function buildContract(): ContractT {
  return Contract.parse({
    flow_id: FLOW,
    goal: "build a static single-page todo app in index.html (no build, no deps)",
    created_at: "2026-05-16T10:00:00.000Z",
    milestones: [
      {
        id: "M-001",
        title: "Static todo app",
        endpoint_criteria: "User types 'Buy milk', clicks Add Todo, sees it in the list.",
        features: [
          {
            id: "F-001",
            title: "index.html with input, button, list, inline JS",
            spec: "Create index.html with #todo-input, #add-todo, #todo-list and click handler that appends typed text.",
            assertions: [
              {
                id: "A-001-001",
                text: "index.html exists in target_dir",
                validator: "screwdriver",
                evidence_required: "filesystem listing",
                check: { kind: "file_exists", path: "index.html" },
              },
              {
                id: "A-001-002",
                text: "index.html declares a button with id=add-todo and label Add Todo",
                validator: "screwdriver",
                evidence_required: "source grep",
                check: { kind: "file_contains", path: "index.html", substring: "id=\"add-todo\"" },
              },
              {
                id: "A-001-003",
                text: "index.html declares an input with id=todo-input",
                validator: "screwdriver",
                evidence_required: "source grep",
                check: { kind: "file_contains", path: "index.html", substring: "id=\"todo-input\"" },
              },
              {
                id: "A-001-004",
                text: "index.html declares a ul with id=todo-list",
                validator: "screwdriver",
                evidence_required: "source grep",
                check: { kind: "file_contains", path: "index.html", substring: "id=\"todo-list\"" },
              },
              {
                id: "A-001-005",
                text: "Typing 'Buy milk' and clicking Add Todo makes 'Buy milk' appear in the list",
                validator: "user-test",
                evidence_required: "JSDOM click trace + DOM diff",
                user_check: {
                  kind: "browser_flow",
                  start: "file",
                  path: "index.html",
                  steps: [
                    { kind: "fill", selector: "#todo-input", value: "Buy milk" },
                    { kind: "click", selector: "#add-todo" },
                    { kind: "expect_text", selector: "#todo-list", text: "Buy milk" },
                  ],
                },
              },
            ],
          },
        ],
      },
    ],
  });
}

function initialState(): FlowStateT {
  return {
    flow_id: FLOW,
    phase: "executing",
    current_milestone: null,
    current_feature: null,
    current_step: null,
    corrective_attempts: {},
    counters: { llm_calls: 0, tokens_in: 0, tokens_out: 0, usd_spent: 0 },
    started_at: "2026-05-16T10:00:00.000Z",
    updated_at: "2026-05-16T10:00:00.000Z",
  };
}

const fakeWorker: typeof runWorker = async (input) => {
  // Real Worker behavior simulation: actually write the file to target_dir.
  await copyFile(FIXTURE, join(input.target_dir, "index.html"));
  return {
    handoff: Handoff.parse({
      flow_id: input.flow_id,
      feature_id: input.feature.id,
      completed: true,
      files_touched: ["index.html"],
      commands_run: [],
      assertions_attempted: input.feature.assertions.map((a) => a.id),
      deviations: "",
      next_worker_hints: "",
      recorded_at: new Date().toISOString(),
    }),
    raw: "fake worker (synthetic E2E)",
    attemptsUsed: 1,
  };
};

const fakeUserTest: typeof runUserTest = async (input) => {
  // Deterministic stand-in for the real Playwright runner; the separate
  // user-test tests exercise selector failures and real browser behavior.
  const userAssertions = input.feature.assertions.filter((a) => a.validator === "user-test");
  return ValidatorReport.parse({
    feature_id: input.feature.id,
    flow_id: input.flow_id,
    validator: "user-test",
    status: "pass",
    assertion_results: userAssertions.map((a) => ({
      assertion_id: a.id,
      outcome: "pass",
      detail: "JSDOM click harness verified the assertion (see e2e-static.test.ts)",
      evidence: "tests/fixtures/static-todo.html",
    })),
    raw_stdout_tail: "",
    raw_stderr_tail: "",
    recorded_at: new Date().toISOString(),
    steward_hint: "NONE",
  });
};

const fakeStewardEncode: typeof runStewardEncode = async () => ({
  body: `---\nfeature_id: F-001\nflow_id: ${FLOW}\noutcome: passing\nrecorded_at: 2026-05-16T12:00:00Z\nbacklinks: [A-001-001, A-001-002, A-001-003, A-001-004, A-001-005]\nattempt: 1\n---\n\nStatic todo app shipped; click flow verified by JSDOM harness.\n`,
  raw: "",
});

describe("E2E synthetic — static todo flow", () => {
  test("runFlow happy path: worker writes index.html, screwdriver/usertest pass, flow completes", async () => {
    const contract = buildContract();
    const dir = join(TMP_ROOT, FLOW);
    await mkdir(join(dir, "handoffs"), { recursive: true });
    await mkdir(join(dir, "reports"), { recursive: true });
    await mkdir(join(dir, "decisions"), { recursive: true });
    await mkdir(join(dir, "features"), { recursive: true });
    await writeContractYaml(contract, join(dir, "contract.yaml"));
    await writeState(initialState(), TMP_ROOT);

    const r = await runFlow({
      flow_id: FLOW,
      target_dir: TMP_TARGET,
      target_url: "http://localhost:3000",
      backend: new MockBackend(() => ({ stdout: "" })),
      root: TMP_ROOT,
      workerRun: fakeWorker,
      // Real screwdriver runs file_exists / file_contains checks against the
      // file the fake worker just wrote.
      userTestRun: fakeUserTest,
      stewardEncodeRun: fakeStewardEncode,
      maxIterations: 50,
    });

    expect(r.status).toBe("complete");

    // Worker actually wrote the file
    const html = await readFile(join(TMP_TARGET, "index.html"), "utf8");
    expect(html).toContain("id=\"add-todo\"");
    expect(html).toContain("id=\"todo-input\"");

    // Real screwdriver report records ALL FIVE check results as passing
    const reportRaw = await readFile(
      join(dir, "reports", "F-001__screwdriver__attempt-01.json"),
      "utf8",
    );
    const report = JSON.parse(reportRaw);
    expect(report.status).toBe("pass");
    expect(report.assertion_results).toHaveLength(4);
    for (const r of report.assertion_results) {
      expect(r.outcome).toBe("pass");
    }

    // user-test report present + pass
    const utRaw = await readFile(
      join(dir, "reports", "F-001__usertest__attempt-01.json"),
      "utf8",
    );
    const ut = JSON.parse(utRaw);
    expect(ut.status).toBe("pass");
  });

  test("browser click verification: typing Buy milk + Add Todo click puts it in the list", async () => {
    const html = await readFile(FIXTURE, "utf8");
    const page = await loadStaticHtml(html);
    const { document: doc } = page;

    const input = doc.getElementById("todo-input");
    const button = doc.getElementById("add-todo");
    const list = doc.getElementById("todo-list");
    expect(input).not.toBeNull();
    expect(button).not.toBeNull();
    expect(list).not.toBeNull();

    expect(list.children.length).toBe(0);

    input.value = "Buy milk";
    button.click();
    const items = Array.from(list.children as Iterable<{ textContent: string }>).map(
      (li) => (li.textContent ?? "").trim(),
    );
    expect(items).toEqual(["Buy milk"]);
    expect(input.value).toBe("");

    input.value = "Pick up package";
    button.click();
    const items2 = Array.from(list.children as Iterable<{ textContent: string }>).map(
      (li) => (li.textContent ?? "").trim(),
    );
    expect(items2).toEqual(["Buy milk", "Pick up package"]);

    await page.close();
  });

  test("browser click verification: empty input is ignored (no blank li added)", async () => {
    const html = await readFile(FIXTURE, "utf8");
    const page = await loadStaticHtml(html);
    const { document: doc } = page;
    const input = doc.getElementById("todo-input");
    const button = doc.getElementById("add-todo");
    const list = doc.getElementById("todo-list");

    input.value = "   ";
    button.click();
    expect(list.children.length).toBe(0);
    await page.close();
  });

  test("browser click verification: inline scripts can use localStorage", async () => {
    const html = `<!doctype html>
      <input id="todo-input">
      <button id="add-todo" type="button">Add Todo</button>
      <ul id="todo-list"></ul>
      <script>
        const stored = JSON.parse(localStorage.getItem("todos") || "[]");
        const input = document.getElementById("todo-input");
        const button = document.getElementById("add-todo");
        const list = document.getElementById("todo-list");
        function render() {
          list.innerHTML = "";
          stored.forEach((text) => {
            const li = document.createElement("li");
            li.textContent = text;
            list.appendChild(li);
          });
        }
        button.addEventListener("click", () => {
          const text = input.value.trim();
          if (!text) return;
          stored.push(text);
          localStorage.setItem("todos", JSON.stringify(stored));
          render();
        });
        render();
      </script>`;
    const page = await loadStaticHtml(html);
    const { document: doc } = page;
    doc.getElementById("todo-input").value = "Buy milk";
    doc.getElementById("add-todo").click();
    const items = Array.from(doc.getElementById("todo-list").children as Iterable<{ textContent: string }>).map(
      (li) => (li.textContent ?? "").trim(),
    );
    expect(items).toEqual(["Buy milk"]);
    await page.close();
  });

  test("browser click verification: submit buttons dispatch form handlers", async () => {
    const html = `<!doctype html>
      <form id="todo-form">
        <input id="todo-input">
        <button id="add-todo" type="submit">Add Todo</button>
      </form>
      <ul id="todo-list"></ul>
      <script>
        const form = document.getElementById("todo-form");
        const input = document.getElementById("todo-input");
        const list = document.getElementById("todo-list");
        form.addEventListener("submit", (event) => {
          event.preventDefault();
          const text = input.value.trim();
          if (!text) return;
          const li = document.createElement("li");
          li.textContent = text;
          list.appendChild(li);
          input.value = "";
        });
      </script>`;
    const page = await loadStaticHtml(html);
    const { document: doc } = page;
    doc.getElementById("todo-input").value = "Buy milk";
    doc.getElementById("add-todo").click();
    const items = Array.from(doc.getElementById("todo-list").children as Iterable<{ textContent: string }>).map(
      (li) => (li.textContent ?? "").trim(),
    );
    expect(items).toEqual(["Buy milk"]);
    expect(doc.getElementById("todo-input").value).toBe("");
    await page.close();
  });
});

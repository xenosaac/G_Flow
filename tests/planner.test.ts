import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import YAML from "yaml";
import { plan, PlannerError, validateContractShape, parseStructured } from "../src/runtime/planner.ts";
import { writeContractYaml, readContractYaml } from "../src/runtime/contract-io.ts";
import { MockBackend } from "../src/adapters/mock.ts";
import type { ContractT } from "../src/artifacts/contract.ts";

const goodTree = {
  milestones: [
    {
      id: "M-001",
      title: "Auth works end-to-end",
      endpoint_criteria: "User can sign up, log out, log back in, see only their todos.",
      features: [
        {
          id: "F-001",
          title: "Signup endpoint",
          spec: "POST /api/auth/signup creates user and returns token.",
          assertions: [
            {
              id: "A-001-001",
              text: "POST /api/auth/signup with valid email and password returns 201 with token field",
              validator: "screwdriver",
              evidence_required: "HTTP response body capture",
              check: {
                kind: "command",
                cmd: ["curl", "-fsS", "http://localhost:3000/api/auth/signup"],
                expected_exit_code: 0,
              },
            },
            {
              id: "A-001-002",
              text: "Filling signup form and clicking Submit redirects to /dashboard",
              validator: "user-test",
              evidence_required: "Screenshot of /dashboard after submit",
              user_check: {
                kind: "browser_flow",
                start: "target_url",
                steps: [
                  { kind: "goto", path: "/signup" },
                  { kind: "fill", selector: "#email", value: "test@example.com" },
                  { kind: "fill", selector: "#password", value: "password123" },
                  { kind: "click", selector: "#submit" },
                  { kind: "expect_url", contains: "/dashboard" },
                ],
              },
            },
          ],
        },
      ],
    },
  ],
};

describe("validateContractShape", () => {
  test("accepts a clean tree", () => {
    const issues = validateContractShape(goodTree);
    expect(issues).toEqual([]);
  });

  test("flags missing milestones", () => {
    const issues = validateContractShape({ milestones: [] });
    expect(issues.some((i) => /milestones missing or empty/i.test(i))).toBe(true);
  });

  test("flags milestone with no features", () => {
    const issues = validateContractShape({
      milestones: [{ id: "M-001", features: [] }],
    });
    expect(issues.some((i) => /no features/i.test(i))).toBe(true);
  });

  test("flags feature with no assertions", () => {
    const issues = validateContractShape({
      milestones: [
        {
          id: "M-001",
          features: [{ id: "F-001", assertions: [] }],
        },
      ],
    });
    expect(issues.some((i) => /no assertions/i.test(i))).toBe(true);
  });

  test("flags empty evidence_required", () => {
    const issues = validateContractShape({
      milestones: [
        {
          id: "M-001",
          features: [
            {
              id: "F-001",
              assertions: [
                {
                  id: "A-001-001",
                  text: "POST /api/health returns 200",
                  validator: "screwdriver",
                  evidence_required: "",
                },
              ],
            },
          ],
        },
      ],
    });
    expect(issues.some((i) => /evidence_required is empty/i.test(i))).toBe(true);
  });

  test("flags invalid validator value", () => {
    const issues = validateContractShape({
      milestones: [
        {
          id: "M-001",
          features: [
            {
              id: "F-001",
              assertions: [
                {
                  id: "A-001-001",
                  text: "POST /api/health returns 200",
                  validator: "playwright",
                  evidence_required: "response body",
                },
              ],
            },
          ],
        },
      ],
    });
    expect(issues.some((i) => /validator must be/i.test(i))).toBe(true);
  });

  test("flags missing/wrong validator-specific check fields", () => {
    const issues = validateContractShape({
      milestones: [
        {
          id: "M-001",
          features: [
            {
              id: "F-001",
              assertions: [
                {
                  id: "A-001-001",
                  text: "index.html exists in the target directory",
                  validator: "screwdriver",
                  evidence_required: "file existence",
                  user_check: {
                    kind: "browser_flow",
                    start: "target_url",
                    steps: [{ kind: "expect_url", contains: "localhost" }],
                  },
                },
                {
                  id: "A-001-002",
                  text: "Clicking Add Todo appends one todo item",
                  validator: "user-test",
                  evidence_required: "browser observation",
                  check: { kind: "file_exists", path: "index.html" },
                },
              ],
            },
          ],
        },
      ],
    });
    expect(issues.some((i) => /screwdriver validator requires check/i.test(i))).toBe(true);
    expect(issues.some((i) => /screwdriver validator must not include user_check/i.test(i))).toBe(true);
    expect(issues.some((i) => /user-test validator requires user_check/i.test(i))).toBe(true);
    expect(issues.some((i) => /user-test validator must not include check/i.test(i))).toBe(true);
  });

  test("flags unsafe user_check file and goto paths", () => {
    const issues = validateContractShape({
      milestones: [
        {
          id: "M-001",
          features: [
            {
              id: "F-001",
              assertions: [
                {
                  id: "A-001-001",
                  text: "Opening the static page shows the title text",
                  validator: "user-test",
                  evidence_required: "browser observation",
                  user_check: {
                    kind: "browser_flow",
                    start: "file",
                    path: "../index.html",
                    steps: [{ kind: "goto", path: "https://example.com" }],
                  },
                },
              ],
            },
          ],
        },
      ],
    });
    expect(issues.some((i) => /user_check is invalid/i.test(i))).toBe(true);
  });

  test("flags vague assertion text", () => {
    const issues = validateContractShape({
      milestones: [
        {
          id: "M-001",
          features: [
            {
              id: "F-001",
              assertions: [
                {
                  id: "A-001-001",
                  text: "The user experience should be good and the app should feel clean",
                  validator: "user-test",
                  evidence_required: "subjective screenshot",
                },
              ],
            },
          ],
        },
      ],
    });
    expect(issues.some((i) => /not behaviorally testable/i.test(i))).toBe(true);
  });

  test("flags sub_assertions (depth > 3)", () => {
    const issues = validateContractShape({
      milestones: [
        {
          id: "M-001",
          features: [
            {
              id: "F-001",
              assertions: [
                {
                  id: "A-001-001",
                  text: "POST /api/health returns 200",
                  validator: "screwdriver",
                  evidence_required: "HTTP capture",
                  sub_assertions: [{ id: "A-001-001-001", text: "x" }],
                },
              ],
            },
          ],
        },
      ],
    });
    expect(issues.some((i) => /depth exceeds 3/i.test(i))).toBe(true);
  });

  test("flags contradictory assertions within a feature", () => {
    const issues = validateContractShape({
      milestones: [
        {
          id: "M-001",
          features: [
            {
              id: "F-001",
              assertions: [
                {
                  id: "A-001-001",
                  text: "User must redirect to /dashboard after submit",
                  validator: "user-test",
                  evidence_required: "screenshot",
                },
                {
                  id: "A-001-002",
                  text: "User must not redirect to /dashboard after submit",
                  validator: "user-test",
                  evidence_required: "screenshot",
                },
              ],
            },
          ],
        },
      ],
    });
    expect(issues.some((i) => /contradict/i.test(i))).toBe(true);
  });

  test("flags duplicate assertion ids within a feature", () => {
    const issues = validateContractShape({
      milestones: [
        {
          id: "M-001",
          features: [
            {
              id: "F-001",
              assertions: [
                {
                  id: "A-001-001",
                  text: "POST /api/health returns 200",
                  validator: "screwdriver",
                  evidence_required: "x",
                },
                {
                  id: "A-001-001",
                  text: "GET /api/health returns 200",
                  validator: "screwdriver",
                  evidence_required: "y",
                },
              ],
            },
          ],
        },
      ],
    });
    expect(issues.some((i) => /duplicate assertion id/i.test(i))).toBe(true);
  });
});

describe("parseStructured", () => {
  test("parses raw JSON", () => {
    const out = parseStructured('{"a":1}');
    expect(out).toEqual({ a: 1 });
  });

  test("strips ```json fences", () => {
    const out = parseStructured('```json\n{"a":1}\n```');
    expect(out).toEqual({ a: 1 });
  });

  test("falls back to YAML", () => {
    const out = parseStructured("a: 1\nb: two\n");
    expect(out).toEqual({ a: 1, b: "two" });
  });

  test("throws on empty input (parsed to null)", () => {
    expect(() => parseStructured("")).toThrow();
  });

  test("throws when result is a bare string (LLM refusal)", () => {
    expect(() => parseStructured("hello there")).toThrow();
  });
});

describe("plan()", () => {
  test("produces a valid contract from a clean LLM response", async () => {
    const backend = new MockBackend(() => ({ stdout: JSON.stringify(goodTree) }));
    const { contract, raw } = await plan({
      flow_id: "f_test_0001",
      goal: "build a todo app",
      cwd: "/tmp",
      backend,
      timeoutMs: 1000,
    });
    expect(contract.flow_id).toBe("f_test_0001");
    expect(contract.goal).toBe("build a todo app");
    expect(contract.milestones).toHaveLength(1);
    expect(contract.milestones[0]!.features).toHaveLength(1);
    expect(contract.milestones[0]!.features[0]!.assertions).toHaveLength(2);
    expect(raw.length).toBeGreaterThan(0);
    expect(backend.calls).toHaveLength(1);
    expect(backend.calls[0]!.role).toBe("planner");
    expect(backend.calls[0]!.prompt).toContain("build a todo app");
  });

  test("strips markdown fences from LLM output", async () => {
    const backend = new MockBackend(() => ({
      stdout: "```json\n" + JSON.stringify(goodTree) + "\n```",
    }));
    const { contract } = await plan({
      flow_id: "f_fences_0001",
      goal: "g",
      cwd: "/tmp",
      backend,
    });
    expect(contract.milestones).toHaveLength(1);
  });

  test("throws PlannerError when backend fails", async () => {
    const backend = new MockBackend(() => ({
      stdout: "",
      stderr: "claude: command not found",
      ok: false,
      exitCode: 127,
    }));
    await expect(
      plan({ flow_id: "f", goal: "g", cwd: "/tmp", backend }),
    ).rejects.toThrow(PlannerError);
  });

  test("throws PlannerError when output is not JSON or YAML", async () => {
    const backend = new MockBackend(() => ({ stdout: "hello there [ { } ]" }));
    await expect(
      plan({ flow_id: "f", goal: "g", cwd: "/tmp", backend }),
    ).rejects.toThrow(PlannerError);
  });

  test("throws PlannerError listing G1 issues for a vague contract", async () => {
    const vagueTree = {
      milestones: [
        {
          id: "M-001",
          title: "Build it",
          endpoint_criteria: "User is happy",
          features: [
            {
              id: "F-001",
              title: "Build everything",
              spec: "make a good app",
              assertions: [
                {
                  id: "A-001-001",
                  text: "The app must be robust and scalable",
                  validator: "user-test",
                  evidence_required: "vibes",
                },
              ],
            },
          ],
        },
      ],
    };
    const backend = new MockBackend(() => ({ stdout: JSON.stringify(vagueTree) }));
    try {
      await plan({ flow_id: "f", goal: "g", cwd: "/tmp", backend });
      throw new Error("expected PlannerError");
    } catch (err) {
      expect(err).toBeInstanceOf(PlannerError);
      const pe = err as PlannerError;
      expect(pe.issues.some((i) => /not behaviorally testable/i.test(i))).toBe(true);
    }
  });

  test("throws PlannerError when sub_assertions appear (depth 4)", async () => {
    const deepTree = {
      milestones: [
        {
          id: "M-001",
          title: "x",
          endpoint_criteria: "x",
          features: [
            {
              id: "F-001",
              title: "x",
              spec: "x",
              assertions: [
                {
                  id: "A-001-001",
                  text: "GET /api/x returns 200 with content-type application/json",
                  validator: "screwdriver",
                  evidence_required: "HTTP capture",
                  sub_assertions: [{ id: "x", text: "x" }],
                },
              ],
            },
          ],
        },
      ],
    };
    const backend = new MockBackend(() => ({ stdout: JSON.stringify(deepTree) }));
    try {
      await plan({ flow_id: "f", goal: "g", cwd: "/tmp", backend });
      throw new Error("expected PlannerError");
    } catch (err) {
      expect(err).toBeInstanceOf(PlannerError);
      const pe = err as PlannerError;
      expect(pe.issues.some((i) => /depth exceeds 3/i.test(i))).toBe(true);
    }
  });
});

describe("contract YAML round-trip", () => {
  let TMP: string;

  beforeEach(async () => {
    TMP = join(tmpdir(), `gflow-contract-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    await mkdir(TMP, { recursive: true });
  });

  afterEach(async () => {
    await rm(TMP, { recursive: true, force: true });
  });

  test("writes a contract and reads it back to the same shape", async () => {
    const backend = new MockBackend(() => ({ stdout: JSON.stringify(goodTree) }));
    const { contract } = await plan({
      flow_id: "f_yaml_0001",
      goal: "build a todo app",
      cwd: TMP,
      backend,
    });
    const path = join(TMP, "contract.yaml");
    await writeContractYaml(contract, path);

    const raw = await readFile(path, "utf8");
    expect(raw).toContain("flow_id: f_yaml_0001");
    expect(raw).toContain("user-test");

    const back: ContractT = await readContractYaml(path);
    expect(back.flow_id).toBe(contract.flow_id);
    expect(back.goal).toBe(contract.goal);
    expect(back.milestones).toEqual(contract.milestones);
  });

  test("YAML parses back identically through generic YAML.parse", async () => {
    const backend = new MockBackend(() => ({ stdout: JSON.stringify(goodTree) }));
    const { contract } = await plan({
      flow_id: "f_yaml_0002",
      goal: "x",
      cwd: TMP,
      backend,
    });
    const path = join(TMP, "contract.yaml");
    await writeContractYaml(contract, path);
    const raw = await readFile(path, "utf8");
    const obj = YAML.parse(raw);
    expect(obj.flow_id).toBe("f_yaml_0002");
    expect(obj.milestones[0].features[0].assertions[0].validator).toBe("screwdriver");
  });
});

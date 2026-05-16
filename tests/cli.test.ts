import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cmdStart, cmdStatus, cmdResume } from "../src/cli/index.ts";
import { latestFlow, listFlows, flowDir } from "../src/runtime/state.ts";

let TMP: string;
let prevRoot: string | undefined;

beforeEach(async () => {
  TMP = join(tmpdir(), `gflow-cli-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  await mkdir(TMP, { recursive: true });
  prevRoot = process.env.GFLOW_ROOT;
  process.env.GFLOW_ROOT = TMP;
});

afterEach(async () => {
  if (prevRoot === undefined) delete process.env.GFLOW_ROOT;
  else process.env.GFLOW_ROOT = prevRoot;
  await rm(TMP, { recursive: true, force: true });
});

describe("cmdStart", () => {
  test("creates flow dir, state.json, goal.txt", async () => {
    const code = await cmdStart("build a todo app with auth");
    expect(code).toBe(0);
    const ids = await listFlows();
    expect(ids.length).toBe(1);
    const state = await latestFlow();
    expect(state?.phase).toBe("planning");
    const goal = await readFile(join(flowDir(state!.flow_id), "goal.txt"), "utf8");
    expect(goal.trim()).toBe("build a todo app with auth");
  });

  test("rejects empty goal", async () => {
    const code = await cmdStart("");
    expect(code).toBe(64);
    const ids = await listFlows();
    expect(ids.length).toBe(0);
  });
});

describe("cmdStatus", () => {
  test("succeeds when no flow exists", async () => {
    const code = await cmdStatus();
    expect(code).toBe(0);
  });

  test("succeeds when flow exists", async () => {
    await cmdStart("foo");
    const code = await cmdStatus();
    expect(code).toBe(0);
  });
});

describe("cmdResume", () => {
  test("succeeds when no resumable flow", async () => {
    const code = await cmdResume();
    expect(code).toBe(0);
  });

  test("succeeds with non-complete flow", async () => {
    await cmdStart("foo");
    const code = await cmdResume();
    expect(code).toBe(0);
  });
});

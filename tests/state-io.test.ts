import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, rm, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ensureFlowDir,
  flowDir,
  initialState,
  latestFlow,
  listFlows,
  newFlowId,
  readState,
  stateFile,
  writeState,
} from "../src/runtime/state.ts";

let TMP: string;

beforeEach(async () => {
  TMP = join(tmpdir(), `gflow-state-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  await mkdir(TMP, { recursive: true });
});

afterEach(async () => {
  await rm(TMP, { recursive: true, force: true });
});

describe("flow id minting", () => {
  test("newFlowId emits f_YYYY_MM_DD_NNNN", () => {
    const id = newFlowId(new Date("2026-05-16T10:00:00.000Z"), 42);
    expect(id).toBe("f_2026_05_16_0042");
  });
});

describe("ensureFlowDir", () => {
  test("creates features/handoffs/reports/decisions subdirs", async () => {
    const id = "f_test_0001";
    await ensureFlowDir(id, TMP);
    const subs = await readdir(flowDir(id, TMP));
    expect(subs.sort()).toEqual(["decisions", "features", "handoffs", "reports"]);
  });
});

describe("writeState / readState round-trip", () => {
  test("writes and reads back", async () => {
    const id = "f_rt_0001";
    await ensureFlowDir(id, TMP);
    const s = initialState(id, new Date("2026-05-16T10:00:00.000Z"));
    await writeState(s, TMP);
    const back = await readState(id, TMP);
    expect(back.flow_id).toBe(id);
    expect(back.phase).toBe("planning");
    expect(back.counters.llm_calls).toBe(0);
  });

  test("writeState updates updated_at", async () => {
    const id = "f_upd_0001";
    await ensureFlowDir(id, TMP);
    const s = initialState(id, new Date("2026-05-16T10:00:00.000Z"));
    s.updated_at = "2020-01-01T00:00:00.000Z";
    await writeState(s, TMP);
    const back = await readState(id, TMP);
    expect(back.updated_at).not.toBe("2020-01-01T00:00:00.000Z");
  });

  test("writeState writes atomically (no .tmp leftover)", async () => {
    const id = "f_atom_0001";
    await ensureFlowDir(id, TMP);
    const s = initialState(id);
    await writeState(s, TMP);
    const files = await readdir(flowDir(id, TMP));
    expect(files).toContain("state.json");
    const leftovers = files.filter((f) => f.includes(".tmp."));
    expect(leftovers).toEqual([]);
  });

  test("written file is valid JSON with newline-terminated content", async () => {
    const id = "f_fmt_0001";
    await ensureFlowDir(id, TMP);
    const s = initialState(id);
    await writeState(s, TMP);
    const raw = await readFile(stateFile(id, TMP), "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(() => JSON.parse(raw)).not.toThrow();
  });
});

describe("listFlows / latestFlow", () => {
  test("listFlows returns [] on missing root", async () => {
    const missing = join(TMP, "does-not-exist");
    const ids = await listFlows(missing);
    expect(ids).toEqual([]);
  });

  test("latestFlow returns null when empty", async () => {
    const s = await latestFlow(undefined, TMP);
    expect(s).toBeNull();
  });

  test("latestFlow returns the most-recently written state", async () => {
    const earlier = "f_2026_05_16_0001";
    const later = "f_2026_05_16_0002";
    await ensureFlowDir(earlier, TMP);
    await writeState(initialState(earlier), TMP);
    await new Promise((r) => setTimeout(r, 10));
    await ensureFlowDir(later, TMP);
    await writeState(initialState(later), TMP);
    const s = await latestFlow(undefined, TMP);
    expect(s?.flow_id).toBe(later);
  });

  test("latestFlow filter excludes complete flows", async () => {
    const a = "f_2026_05_16_0010";
    const b = "f_2026_05_16_0011";
    await ensureFlowDir(a, TMP);
    await writeState({ ...initialState(a), phase: "executing" }, TMP);
    await new Promise((r) => setTimeout(r, 10));
    await ensureFlowDir(b, TMP);
    await writeState({ ...initialState(b), phase: "complete" }, TMP);
    const s = await latestFlow((x) => x.phase !== "complete", TMP);
    expect(s?.flow_id).toBe(a);
  });

  test("latestFlow skips dirs without state.json", async () => {
    const lonely = "f_lonely_0001";
    await mkdir(join(TMP, lonely), { recursive: true });
    const real = "f_real_0001";
    await ensureFlowDir(real, TMP);
    await writeState(initialState(real), TMP);
    const s = await latestFlow(undefined, TMP);
    expect(s?.flow_id).toBe(real);
  });
});

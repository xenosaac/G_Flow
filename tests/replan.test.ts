import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import YAML from "yaml";
import { startFlowAPI, replanFlowAPI } from "../src/runtime/flow-control.ts";
import { writeState } from "../src/runtime/state.ts";
import { MockBackend } from "../src/adapters/mock.ts";
import type { FlowStateT } from "../src/artifacts/state.ts";

const v1 = {
  milestones: [
    {
      id: "M-001",
      title: "v1",
      endpoint_criteria: "static page exists",
      features: [
        {
          id: "F-001",
          title: "create",
          spec: "make index.html",
          assertions: [
            {
              id: "A-001-001",
              text: "index.html exists",
              validator: "screwdriver",
              evidence_required: "ls",
              check: { kind: "file_exists", path: "index.html" },
            },
          ],
        },
      ],
    },
  ],
};

const v2 = {
  milestones: [
    {
      id: "M-001",
      title: "v2 (revised)",
      endpoint_criteria: "static page + about page",
      features: [
        {
          id: "F-001",
          title: "create",
          spec: "make index.html",
          assertions: [
            {
              id: "A-001-001",
              text: "index.html exists",
              validator: "screwdriver",
              evidence_required: "ls",
              check: { kind: "file_exists", path: "index.html" },
            },
          ],
        },
        {
          id: "F-002",
          title: "about page",
          spec: "make about.html",
          assertions: [
            {
              id: "A-002-001",
              text: "about.html exists",
              validator: "screwdriver",
              evidence_required: "ls",
              check: { kind: "file_exists", path: "about.html" },
            },
          ],
        },
      ],
    },
  ],
};

let TMP: string;

beforeEach(async () => {
  TMP = join(tmpdir(), `gflow-replan-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  await mkdir(TMP, { recursive: true });
});

afterEach(async () => {
  await rm(TMP, { recursive: true, force: true });
});

describe("replanFlowAPI", () => {
  test("rewrites contract.yaml in place; preserves flow_id; bumps feature count", async () => {
    const backendV1 = new MockBackend(() => ({ stdout: JSON.stringify(v1) }));
    const r1 = await startFlowAPI({ goal: "make a site", backend: backendV1, root: TMP });
    expect(r1.features).toBe(1);
    const before = await readFile(r1.contract_path, "utf8");

    const backendV2 = new MockBackend(() => ({ stdout: JSON.stringify(v2) }));
    const r2 = await replanFlowAPI({
      flow_id: r1.flow_id,
      backend: backendV2,
      clarifications: "also add an about page",
      root: TMP,
    });
    expect(r2.flow_id).toBe(r1.flow_id);
    expect(r2.features).toBe(2);
    const after = await readFile(r2.contract_path, "utf8");
    expect(after).not.toBe(before);
    const yaml = YAML.parse(after);
    expect(yaml.milestones[0].features.map((f: { id: string }) => f.id)).toEqual([
      "F-001",
      "F-002",
    ]);
  });

  test("rejects unknown flow_id", async () => {
    const backend = new MockBackend(() => ({ stdout: "{}" }));
    await expect(
      replanFlowAPI({ flow_id: "f_nope_0000", backend, clarifications: "x", root: TMP }),
    ).rejects.toThrow(/not found/);
  });

  test("rejects flow not in phase=planning", async () => {
    const backend = new MockBackend(() => ({ stdout: JSON.stringify(v1) }));
    const r1 = await startFlowAPI({ goal: "x", backend, root: TMP });
    // Manually flip state to executing on disk
    const executing: FlowStateT = {
      flow_id: r1.flow_id,
      phase: "executing",
      current_milestone: null,
      current_feature: null,
      current_step: null,
      corrective_attempts: {},
      counters: { llm_calls: 0, tokens_in: 0, tokens_out: 0, usd_spent: 0 },
      started_at: "2026-05-16T10:00:00.000Z",
      updated_at: "2026-05-16T10:00:00.000Z",
    };
    await writeState(executing, TMP);
    await expect(
      replanFlowAPI({ flow_id: r1.flow_id, backend, clarifications: "x", root: TMP }),
    ).rejects.toThrow(/phase=executing/);
  });

  test("requires non-empty flow_id", async () => {
    const backend = new MockBackend(() => ({ stdout: "{}" }));
    await expect(
      replanFlowAPI({ flow_id: "  ", backend, clarifications: "x", root: TMP }),
    ).rejects.toThrow(/flow_id required/);
  });
});

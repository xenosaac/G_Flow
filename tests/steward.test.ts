import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  runStewardEncode,
  runStewardTriage,
  writeDecision,
  writeTriage,
} from "../src/runtime/steward.ts";
import { MockBackend } from "../src/adapters/mock.ts";
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
      text: "redirects to /dashboard",
      validator: "user-test",
      evidence_required: "screenshot",
      status: "pending",
      origin: "original",
      attempts: [],
    },
  ],
};

const decisionMd = `---
feature_id: F-001
flow_id: f_test_0001
outcome: passing
recorded_at: 2026-05-16T11:00:00.000Z
backlinks: [A-001-001, A-001-002]
attempt: 1
---

## What was built
Signup endpoint and form.

## What worked
- A-001-001 passed.
- A-001-002 passed.

## What failed
(none)

## Lessons for future flows
- Always run \`router.refresh()\` after mutations.
`;

describe("runStewardEncode", () => {
  test("returns body that starts with YAML frontmatter", async () => {
    const backend = new MockBackend(() => ({ stdout: decisionMd }));
    const r = await runStewardEncode({
      flow_id: "f_test_0001",
      feature,
      attempt: 1,
      outcome: "passing",
      handoff: null,
      screwdriver: null,
      usertest: null,
      cwd: "/tmp",
      backend,
      timeoutMs: 1000,
    });
    expect(r.body.startsWith("---")).toBe(true);
    expect(r.body).toContain("feature_id: F-001");
    expect(backend.calls[0]!.role).toBe("steward");
    expect(backend.calls[0]!.prompt).toContain("A-001-001");
  });

  test("throws when body lacks YAML frontmatter", async () => {
    const backend = new MockBackend(() => ({ stdout: "# Just a heading\nno frontmatter" }));
    await expect(
      runStewardEncode({
        flow_id: "f",
        feature,
        attempt: 1,
        outcome: "failing",
        handoff: null,
        screwdriver: null,
        usertest: null,
        cwd: "/tmp",
        backend,
        timeoutMs: 1000,
      }),
    ).rejects.toThrow(/frontmatter/);
  });
});

describe("runStewardTriage", () => {
  test("parses BROKEN_IMPL classification", async () => {
    const backend = new MockBackend(() => ({
      stdout: JSON.stringify({
        classification: "BROKEN_IMPL",
        rationale: "redirect handler missing router.refresh()",
        new_assertions: [],
      }),
    }));
    const r = await runStewardTriage({
      flow_id: "f_test_0001",
      feature,
      failures: [
        { assertion_id: "A-001-002", outcome: "fail", detail: "stale list" },
      ],
      handoff: null,
      screwdriver: null,
      usertest: null,
      corrective_attempts: 0,
      cwd: "/tmp",
      backend,
      timeoutMs: 1000,
    });
    expect(r.classification).toBe("BROKEN_IMPL");
    expect(r.new_assertions).toEqual([]);
  });

  test("parses MISSING_ASSERTION with new_assertions", async () => {
    const backend = new MockBackend(() => ({
      stdout: JSON.stringify({
        classification: "MISSING_ASSERTION",
        rationale: "scope expanded",
        new_assertions: [
          {
            id: "A-001-003",
            text: "Logout button clears session cookie",
            validator: "user-test",
            evidence_required: "cookie inspection after click",
          },
        ],
      }),
    }));
    const r = await runStewardTriage({
      flow_id: "f_test_0001",
      feature,
      failures: [],
      handoff: null,
      screwdriver: null,
      usertest: null,
      corrective_attempts: 1,
      cwd: "/tmp",
      backend,
      timeoutMs: 1000,
    });
    expect(r.classification).toBe("MISSING_ASSERTION");
    expect(r.new_assertions).toHaveLength(1);
    expect(r.new_assertions[0]!.id).toBe("A-001-003");
  });

  test("forcedHint='INFRA' short-circuits without calling backend", async () => {
    const backend = new MockBackend(() => ({ stdout: "should never be called" }));
    const r = await runStewardTriage({
      flow_id: "f",
      feature,
      failures: [],
      handoff: null,
      screwdriver: null,
      usertest: null,
      corrective_attempts: 0,
      cwd: "/tmp",
      backend,
      forcedHint: "INFRA",
    });
    expect(r.classification).toBe("INFRA");
    expect(backend.calls).toHaveLength(0);
  });

  test("rejects unknown classification", async () => {
    const backend = new MockBackend(() => ({
      stdout: JSON.stringify({ classification: "WHATEVER", rationale: "x" }),
    }));
    await expect(
      runStewardTriage({
        flow_id: "f",
        feature,
        failures: [],
        handoff: null,
        screwdriver: null,
        usertest: null,
        corrective_attempts: 0,
        cwd: "/tmp",
        backend,
        timeoutMs: 1000,
      }),
    ).rejects.toThrow();
  });

  test("throws on malformed output", async () => {
    const backend = new MockBackend(() => ({ stdout: "literally not json" }));
    await expect(
      runStewardTriage({
        flow_id: "f",
        feature,
        failures: [],
        handoff: null,
        screwdriver: null,
        usertest: null,
        corrective_attempts: 0,
        cwd: "/tmp",
        backend,
        timeoutMs: 1000,
      }),
    ).rejects.toThrow();
  });
});

describe("artifact writers", () => {
  let TMP: string;
  beforeEach(async () => {
    TMP = join(tmpdir(), `gflow-steward-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    await mkdir(TMP, { recursive: true });
  });
  afterEach(async () => {
    await rm(TMP, { recursive: true, force: true });
  });

  test("writeDecision writes markdown to decisions/<id>__attempt-NN.md", async () => {
    const p = await writeDecision(decisionMd, "F-001", 1, TMP);
    expect(p.endsWith("F-001__attempt-01.md")).toBe(true);
    const back = await readFile(p, "utf8");
    expect(back.startsWith("---")).toBe(true);
  });

  test("writeTriage writes JSON to reports/<id>__triage__attempt-NN.json", async () => {
    const p = await writeTriage(
      {
        classification: "BROKEN_IMPL",
        rationale: "test",
        new_assertions: [],
        raw: "{}",
      },
      "F-001",
      2,
      TMP,
    );
    expect(p.endsWith("F-001__triage__attempt-02.json")).toBe(true);
    const back = JSON.parse(await readFile(p, "utf8"));
    expect(back.classification).toBe("BROKEN_IMPL");
  });
});

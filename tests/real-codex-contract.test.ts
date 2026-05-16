/**
 * Regression test: parse the contract.yaml produced by a REAL codex Phase 1
 * run (saved as a fixture) through the Zod schema. Proves the production
 * Planner output validates cleanly + uses the new per-assertion `check`
 * field with the expected discriminated-union shape.
 */
import { describe, test, expect } from "bun:test";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { Contract } from "../src/artifacts/contract.ts";
import { validateContractShape } from "../src/runtime/planner.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "fixtures", "real-codex-contract.yaml");

describe("real codex Phase 1 output", () => {
  test("contract.yaml parses through Zod without errors", async () => {
    const raw = await readFile(FIXTURE, "utf8");
    const obj = YAML.parse(raw);
    const parsed = Contract.parse(obj);
    expect(parsed.flow_id).toMatch(/^f_\d{4}_\d{2}_\d{2}_/);
    expect(parsed.milestones.length).toBeGreaterThanOrEqual(1);
  });

  test("contract passes G1 self-check (no issues)", async () => {
    const raw = await readFile(FIXTURE, "utf8");
    const obj = YAML.parse(raw);
    const issues = validateContractShape(obj);
    expect(issues).toEqual([]);
  });

  test("at least one assertion uses each of the three check kinds", async () => {
    const raw = await readFile(FIXTURE, "utf8");
    const obj = YAML.parse(raw);
    const parsed = Contract.parse(obj);
    const checks: string[] = [];
    for (const m of parsed.milestones) {
      for (const f of m.features) {
        for (const a of f.assertions) {
          if (a.check) checks.push(a.check.kind);
        }
      }
    }
    expect(checks).toContain("file_exists");
    expect(checks).toContain("file_contains");
    expect(checks).toContain("command");
  });

  test("every screwdriver assertion has a check (planner prompt enforced)", async () => {
    const raw = await readFile(FIXTURE, "utf8");
    const obj = YAML.parse(raw);
    const parsed = Contract.parse(obj);
    const offenders: string[] = [];
    for (const m of parsed.milestones) {
      for (const f of m.features) {
        for (const a of f.assertions) {
          if (a.validator === "screwdriver" && !a.check) {
            offenders.push(a.id);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

import YAML from "yaml";
import { Contract, type ContractT, type AssertionT } from "../artifacts/contract.ts";
import type { AgentBackend } from "../adapters/backend.ts";
import { loadPrompt, renderPrompt } from "./render-prompt.ts";

// G1: hard depth limit. milestones → features → assertions. No fourth level.
export const MAX_DEPTH = 3;

const VAGUE_TERMS = [
  "good",
  "great",
  "fast",
  "robust",
  "user-friendly",
  "user friendly",
  "clean",
  "elegant",
  "modern",
  "scalable",
  "performant",
  "nice",
  "seamless",
  "intuitive",
  "polished",
];

const PLANNER_TIMEOUT_MS = 30 * 60 * 1000; // 30 min per spec §6

export interface PlannerInput {
  flow_id: string;
  goal: string;
  clarifications?: string;
  cwd: string;
  backend: AgentBackend;
  /** Optional override for the timeout (used in tests). */
  timeoutMs?: number;
}

export interface PlannerResult {
  contract: ContractT;
  raw: string;
}

export class PlannerError extends Error {
  constructor(message: string, public readonly issues: string[] = []) {
    super(message);
    this.name = "PlannerError";
  }
}

export async function plan(input: PlannerInput): Promise<PlannerResult> {
  const template = await loadPrompt("planner-expand-tree");
  const prompt = renderPrompt(template, {
    goal: input.goal,
    clarifications: input.clarifications ?? "(none)",
  });

  const result = await input.backend.run({
    role: "planner",
    prompt,
    cwd: input.cwd,
    timeoutMs: input.timeoutMs ?? PLANNER_TIMEOUT_MS,
  });

  if (!result.ok) {
    throw new PlannerError(
      `planner backend failed: exit=${result.exitCode} timedOut=${result.timedOut}`,
      [result.stderr.trim().slice(0, 800) || "(no stderr)"],
    );
  }

  let parsed: unknown;
  try {
    parsed = parseStructured(result.stdout);
  } catch (err) {
    throw new PlannerError(
      `planner output was not parseable as JSON/YAML: ${(err as Error).message}`,
      [result.stdout.slice(0, 800)],
    );
  }

  // attach metadata required by Contract schema
  const now = new Date().toISOString();
  const draft = {
    flow_id: input.flow_id,
    goal: input.goal,
    created_at: now,
    ...(typeof parsed === "object" && parsed !== null ? (parsed as object) : {}),
  };

  const issues = validateContractShape(draft);
  if (issues.length) {
    throw new PlannerError(
      `contract failed G1 self-check (${issues.length} issue${issues.length === 1 ? "" : "s"})`,
      issues,
    );
  }

  // final schema parse: throws if Zod still rejects
  let contract: ContractT;
  try {
    contract = Contract.parse(draft);
  } catch (err) {
    throw new PlannerError(
      `contract failed Zod schema validation: ${(err as Error).message}`,
      [JSON.stringify(draft).slice(0, 800)],
    );
  }

  return { contract, raw: result.stdout };
}

/** Parse a JSON or YAML object from raw LLM output, tolerating markdown fences. */
export function parseStructured(raw: string): unknown {
  let text = raw.trim();
  // strip leading/trailing markdown fences
  text = text.replace(/^```(?:json|yaml|yml)?\s*\r?\n?/i, "");
  text = text.replace(/\r?\n?```\s*$/i, "");

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    try {
      parsed = YAML.parse(text);
    } catch (e) {
      throw new Error(`not valid JSON or YAML: ${(e as Error).message}`);
    }
  }
  if (parsed === null || parsed === undefined) {
    throw new Error("parsed to null/undefined");
  }
  if (typeof parsed !== "object") {
    throw new Error(`expected an object/array, got ${typeof parsed}`);
  }
  return parsed;
}

/**
 * G1 self-check on the contract shape.
 *
 * Validates:
 *  - depth = 3 exactly (milestones → features → assertions, no `sub_assertions`)
 *  - every milestone has ≥1 feature
 *  - every feature has ≥1 assertion
 *  - assertion.text is behaviorally testable (no vague-only phrasing)
 *  - assertion.evidence_required is non-empty
 *  - assertion.validator ∈ { screwdriver, user-test }
 *  - no contradictory assertion pairs within the same feature
 *
 * Returns issue strings (empty when contract is clean).
 */
export function validateContractShape(raw: unknown): string[] {
  const issues: string[] = [];
  if (!raw || typeof raw !== "object") {
    issues.push("contract is not an object");
    return issues;
  }
  const c = raw as Record<string, unknown>;
  if (!Array.isArray(c.milestones) || c.milestones.length === 0) {
    issues.push("milestones missing or empty (depth-1)");
    return issues;
  }
  const milestoneIds = new Set<string>();
  for (const m of c.milestones) {
    if (!m || typeof m !== "object") {
      issues.push("milestone is not an object");
      continue;
    }
    const milestone = m as Record<string, unknown>;
    const mid = String(milestone.id ?? "");
    if (!mid) issues.push(`milestone has no id`);
    if (milestoneIds.has(mid)) issues.push(`duplicate milestone id: ${mid}`);
    milestoneIds.add(mid);

    if (!Array.isArray(milestone.features) || milestone.features.length === 0) {
      issues.push(`milestone ${mid}: no features (depth-2 missing)`);
      continue;
    }
    const featureIds = new Set<string>();
    for (const f of milestone.features) {
      if (!f || typeof f !== "object") {
        issues.push(`milestone ${mid}: feature is not an object`);
        continue;
      }
      const feature = f as Record<string, unknown>;
      const fid = String(feature.id ?? "");
      if (!fid) issues.push(`milestone ${mid}: feature has no id`);
      if (featureIds.has(fid)) issues.push(`milestone ${mid}: duplicate feature id ${fid}`);
      featureIds.add(fid);

      if (!Array.isArray(feature.assertions) || feature.assertions.length === 0) {
        issues.push(`feature ${fid}: no assertions (depth-3 missing)`);
        continue;
      }

      // G1: reject any fourth level
      const assertionIds = new Set<string>();
      const seenAssertions: AssertionT[] = [];
      for (const a of feature.assertions) {
        if (!a || typeof a !== "object") {
          issues.push(`feature ${fid}: assertion is not an object`);
          continue;
        }
        const ass = a as Record<string, unknown>;
        const aid = String(ass.id ?? "");
        if (!aid) issues.push(`feature ${fid}: assertion has no id`);
        if (assertionIds.has(aid)) issues.push(`feature ${fid}: duplicate assertion id ${aid}`);
        assertionIds.add(aid);

        if ("sub_assertions" in ass || "subAssertions" in ass) {
          issues.push(`assertion ${aid}: depth exceeds 3 (sub_assertions not allowed)`);
        }
        const text = String(ass.text ?? "");
        if (!isTestable(text)) {
          issues.push(`assertion ${aid}: not behaviorally testable: "${truncate(text, 60)}"`);
        }
        const evidence = String(ass.evidence_required ?? "");
        if (evidence.trim() === "") {
          issues.push(`assertion ${aid}: evidence_required is empty`);
        }
        const validator = String(ass.validator ?? "");
        if (validator !== "screwdriver" && validator !== "user-test") {
          issues.push(`assertion ${aid}: validator must be screwdriver or user-test (got "${validator}")`);
        }
        seenAssertions.push(ass as unknown as AssertionT);
      }

      // contradiction check within this feature
      for (const [a, b] of findContradictions(seenAssertions)) {
        issues.push(`feature ${fid}: assertions ${a} and ${b} appear to contradict`);
      }
    }
  }
  return issues;
}

function isTestable(text: string): boolean {
  if (!text || text.trim().length < 10) return false;
  const lower = text.toLowerCase();
  for (const v of VAGUE_TERMS) {
    // word-boundary match for the vague term
    const re = new RegExp(`\\b${v}\\b`, "i");
    if (re.test(lower)) return false;
  }
  return true;
}

function findContradictions(assertions: AssertionT[]): [string, string][] {
  const pairs: [string, string][] = [];
  for (let i = 0; i < assertions.length; i++) {
    for (let j = i + 1; j < assertions.length; j++) {
      const a = (assertions[i] as unknown as { text?: string }).text ?? "";
      const b = (assertions[j] as unknown as { text?: string }).text ?? "";
      if (contradictoryClauses(a, b)) {
        pairs.push([assertions[i]!.id, assertions[j]!.id]);
      }
    }
  }
  return pairs;
}

function contradictoryClauses(a: string, b: string): boolean {
  const ca = extractClause(a);
  const cb = extractClause(b);
  if (!ca || !cb) return false;
  if (ca.negated === cb.negated) return false;
  return ca.tail !== "" && ca.tail === cb.tail;
}

/**
 * Find the first modal verb in the sentence and return (negated?, what follows).
 * "User must redirect to /dashboard"     → { negated: false, tail: "redirect to /dashboard" }
 * "User must not redirect to /dashboard" → { negated: true,  tail: "redirect to /dashboard" }
 */
function extractClause(s: string): { negated: boolean; tail: string } | null {
  const lower = s
    .toLowerCase()
    .trim()
    .replace(/[.!?]+$/, "")
    .replace(/\s+/g, " ");
  const m = lower.match(/\b(must|should|will|shall|may|does|do|is|are)(\s+not)?\s+(.+)$/);
  if (!m) return null;
  return { negated: Boolean(m[2]), tail: m[3]!.trim() };
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}

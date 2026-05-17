import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentBackend } from "../adapters/backend.ts";
import { Contract, type ContractT } from "../artifacts/contract.ts";
import { parseStructured, validateContractShape } from "./planner.ts";

const REVIEW_TIMEOUT_MS = 10 * 60 * 1000;

export interface ClarificationQuestion {
  id: string;
  text: string;
  why: string;
}

export interface ClarificationAnswer {
  question_id: string;
  answer: string;
}

export type ClarifyResult =
  | {
      status: "needs_clarification";
      questions: ClarificationQuestion[];
      brief_md?: string;
      assumptions?: string[];
    }
  | {
      status: "ready";
      brief_md: string;
      assumptions: string[];
    };

export type EngineeringReviewResult =
  | {
      status: "ready";
      contract: ContractT;
      raw: string;
    }
  | {
      status: "issues";
      issues: string[];
      raw: string;
    };

export interface PlanningReviewProvider {
  runIntake(
    goal: string,
    history: ClarificationAnswer[],
  ): Promise<ClarifyResult>;
  runEngineeringReview(
    goal: string,
    clarified_brief: string,
    draft_contract: ContractT,
  ): Promise<EngineeringReviewResult>;
}

export class GStackPlanningReviewProvider implements PlanningReviewProvider {
  constructor(
    private readonly opts: {
      backend: AgentBackend;
      cwd: string;
      gstackDir?: string;
      timeoutMs?: number;
    },
  ) {}

  async runIntake(
    goal: string,
    history: ClarificationAnswer[],
  ): Promise<ClarifyResult> {
    const skills = await loadGStackSkills(this.opts.gstackDir);
    const prompt = [
      "# G_Flow GStack Intake Gate",
      "",
      "Apply the GStack office-hours intake workflow to decide whether the goal is specific enough for an engineering validation contract.",
      "",
      "Return JSON only. Use one of these exact shapes:",
      "",
      '{"status":"needs_clarification","questions":[{"id":"q1","text":"...","why":"..."}],"brief_md":"optional current brief","assumptions":[]}',
      '{"status":"ready","brief_md":"...","assumptions":["..."]}',
      "",
      "Ask at most five questions. Do not ask questions already answered in the history.",
      "",
      "## GStack skill text",
      skills,
      "",
      "## Goal",
      goal,
      "",
      "## Clarification history",
      formatHistory(history),
    ].join("\n");
    const result = await this.opts.backend.run({
      role: "planner",
      prompt,
      cwd: this.opts.cwd,
      timeoutMs: this.opts.timeoutMs ?? REVIEW_TIMEOUT_MS,
    });
    if (!result.ok) {
      throw new PlanningReviewError("GStack intake backend failed", [
        result.stderr.trim().slice(0, 800) || "(no stderr)",
      ]);
    }
    return parseClarifyResult(result.stdout);
  }

  async runEngineeringReview(
    goal: string,
    clarified_brief: string,
    draft_contract: ContractT,
  ): Promise<EngineeringReviewResult> {
    const skills = await loadGStackSkills(this.opts.gstackDir);
    const draftJson = JSON.stringify(draft_contract, null, 2);
    const prompt = [
      "# G_Flow GStack Engineering Review Gate",
      "",
      "Apply the GStack plan engineering review workflow to the draft validation contract.",
      "",
      "Return JSON only. Use one of these exact shapes:",
      "",
      '{"status":"ready","contract":{...reviewed contract...}}',
      '{"status":"issues","issues":["..."]}',
      "",
      "A ready contract must preserve the same schema and must include `check` for every screwdriver assertion and `user_check` for every user-test assertion.",
      "",
      "## GStack skill text",
      skills,
      "",
      "## Goal",
      goal,
      "",
      "## Clarified brief",
      clarified_brief,
      "",
      "## Draft contract JSON",
      draftJson,
    ].join("\n");
    const result = await this.opts.backend.run({
      role: "planner",
      prompt,
      cwd: this.opts.cwd,
      timeoutMs: this.opts.timeoutMs ?? REVIEW_TIMEOUT_MS,
    });
    if (!result.ok) {
      return {
        status: "issues",
        issues: [
          `GStack engineering review backend failed: ${result.stderr.trim().slice(0, 800) || "(no stderr)"}`,
        ],
        raw: result.stderr,
      };
    }
    return parseEngineeringReview(result.stdout);
  }
}

export class PlanningReviewError extends Error {
  constructor(message: string, public readonly issues: string[] = []) {
    super(message);
    this.name = "PlanningReviewError";
  }
}

export function parseClarifyResult(raw: string): ClarifyResult {
  const parsed = parseStructured(raw);
  const obj = Array.isArray(parsed) ? { status: "needs_clarification", questions: parsed } : parsed;
  if (!obj || typeof obj !== "object") {
    throw new PlanningReviewError("GStack intake output was not an object", [
      raw.slice(0, 800),
    ]);
  }
  const record = obj as Record<string, unknown>;
  if (record.status === "ready") {
    const brief = String(record.brief_md ?? "").trim();
    if (!brief) {
      throw new PlanningReviewError("GStack intake ready result missing brief_md");
    }
    return {
      status: "ready",
      brief_md: brief,
      assumptions: stringArray(record.assumptions),
    };
  }
  if (record.status === "needs_clarification") {
    const questions = parseQuestions(record.questions);
    if (questions.length === 0) {
      throw new PlanningReviewError("GStack intake needs_clarification result had no questions");
    }
    return {
      status: "needs_clarification",
      questions,
      brief_md:
        typeof record.brief_md === "string" && record.brief_md.trim()
          ? record.brief_md
          : undefined,
      assumptions: stringArray(record.assumptions),
    };
  }
  throw new PlanningReviewError("GStack intake output status must be ready or needs_clarification", [
    raw.slice(0, 800),
  ]);
}

export function parseEngineeringReview(raw: string): EngineeringReviewResult {
  const parsed = parseStructured(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      status: "issues",
      issues: ["GStack engineering review output was not an object"],
      raw,
    };
  }
  const record = parsed as Record<string, unknown>;
  if (record.status === "issues") {
    return {
      status: "issues",
      issues: stringArray(record.issues).length
        ? stringArray(record.issues)
        : ["GStack engineering review returned issues without details"],
      raw,
    };
  }

  const candidate =
    record.status === "ready" && record.contract
      ? record.contract
      : record.status === undefined
        ? parsed
        : null;
  if (!candidate) {
    return {
      status: "issues",
      issues: ["GStack engineering review status must be ready or issues"],
      raw,
    };
  }

  const shapeIssues = validateContractShape(candidate);
  if (shapeIssues.length > 0) {
    return { status: "issues", issues: shapeIssues, raw };
  }
  try {
    return { status: "ready", contract: Contract.parse(candidate), raw };
  } catch (err) {
    return {
      status: "issues",
      issues: [`reviewed contract failed schema validation: ${(err as Error).message}`],
      raw,
    };
  }
}

async function loadGStackSkills(dir = process.env.GFLOW_GSTACK_DIR): Promise<string> {
  if (!dir) return "(GFLOW_GSTACK_DIR not set; apply the named GStack workflows from general instructions.)";
  const files = ["office-hours/SKILL.md", "plan-eng-review/SKILL.md"];
  const chunks: string[] = [];
  for (const rel of files) {
    try {
      chunks.push(`## ${rel}\n${await readFile(join(dir, rel), "utf8")}`);
    } catch {
      chunks.push(`## ${rel}\n(missing from ${dir})`);
    }
  }
  return chunks.join("\n\n");
}

function parseQuestions(raw: unknown): ClarificationQuestion[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((q, idx) => {
      if (typeof q === "string") {
        return { id: `q${idx + 1}`, text: q, why: "Clarifies scope and success criteria." };
      }
      if (!q || typeof q !== "object") return null;
      const obj = q as Record<string, unknown>;
      const text = String(obj.text ?? "").trim();
      if (!text) return null;
      return {
        id: String(obj.id ?? `q${idx + 1}`).trim() || `q${idx + 1}`,
        text,
        why: String(obj.why ?? "Clarifies scope and success criteria.").trim(),
      };
    })
    .filter((q): q is ClarificationQuestion => q !== null);
}

function stringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((v) => String(v).trim()).filter(Boolean);
}

function formatHistory(history: ClarificationAnswer[]): string {
  if (history.length === 0) return "(none)";
  return history
    .map((a) => `- ${a.question_id}: ${a.answer}`)
    .join("\n");
}

export function clarifiedBriefForPrompt(result: ClarifyResult): string {
  if (result.status === "ready") {
    return [
      result.brief_md,
      result.assumptions.length ? `\nAssumptions:\n${result.assumptions.map((a) => `- ${a}`).join("\n")}` : "",
    ].join("").trim();
  }
  return [
    result.brief_md ?? "",
    result.assumptions?.length ? `\nAssumptions:\n${result.assumptions.map((a) => `- ${a}`).join("\n")}` : "",
  ].join("").trim();
}

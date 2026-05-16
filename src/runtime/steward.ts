import { writeFile, mkdir, rename } from "node:fs/promises";
import { join, dirname } from "node:path";
import { z } from "zod";
import type { AgentBackend } from "../adapters/backend.ts";
import type { FeatureT, AssertionT } from "../artifacts/contract.ts";
import { Assertion } from "../artifacts/contract.ts";
import type { ValidatorReportT, AssertionResultT } from "../artifacts/reports.ts";
import type { HandoffT } from "../artifacts/handoff.ts";
import { TriageClassification, type TriageClassificationT } from "../artifacts/reports.ts";
import { loadPrompt, renderPrompt } from "./render-prompt.ts";
import { parseStructured } from "./planner.ts";

const STEWARD_TIMEOUT_MS = 2 * 60 * 1000;
const STEWARD_RETRIES = 2;
const STEWARD_BACKOFFS_MS = [5_000, 15_000];

export interface RunStewardEncodeInput {
  flow_id: string;
  feature: FeatureT;
  attempt: number;
  outcome: "passing" | "failing";
  handoff: HandoffT | null;
  screwdriver: ValidatorReportT | null;
  usertest: ValidatorReportT | null;
  cwd: string;
  backend: AgentBackend;
  timeoutMs?: number;
}

export interface RunStewardEncodeResult {
  /** Full markdown body, including YAML frontmatter. */
  body: string;
  raw: string;
}

/** Generate a decision.md body via Steward.encode. */
export async function runStewardEncode(
  input: RunStewardEncodeInput,
): Promise<RunStewardEncodeResult> {
  const template = await loadPrompt("steward-encode");
  const prompt = renderPrompt(template, {
    flow_id: input.flow_id,
    feature_id: input.feature.id,
    feature_title: input.feature.title,
    feature_spec: input.feature.spec,
    attempt: String(input.attempt),
    outcome: input.outcome,
    assertions_block: formatAssertions(input.feature),
    handoff_block: input.handoff ? jsonBlock(input.handoff) : "(no handoff)",
    screwdriver_block: input.screwdriver
      ? jsonBlock(input.screwdriver)
      : "(no screwdriver report)",
    usertest_block: input.usertest
      ? jsonBlock(input.usertest)
      : "(no user-test report)",
  });

  const raw = await runWithRetries({
    backend: input.backend,
    role: "steward",
    prompt,
    cwd: input.cwd,
    timeoutMs: input.timeoutMs ?? STEWARD_TIMEOUT_MS,
  });

  if (!raw.trim().startsWith("---")) {
    throw new Error(
      `steward.encode: expected YAML frontmatter; got: ${raw.slice(0, 200)}`,
    );
  }
  return { body: raw, raw };
}

const TriageOutput = z.object({
  classification: TriageClassification,
  rationale: z.string().default(""),
  new_assertions: z.array(Assertion).default([]),
});
export type TriageOutputT = z.infer<typeof TriageOutput>;

export interface RunStewardTriageInput {
  flow_id: string;
  feature: FeatureT;
  failures: AssertionResultT[];
  handoff: HandoffT | null;
  screwdriver: ValidatorReportT | null;
  usertest: ValidatorReportT | null;
  corrective_attempts: number;
  cwd: string;
  backend: AgentBackend;
  /** When set, force classification (used when usertest already reported tool_error). */
  forcedHint?: "INFRA";
  timeoutMs?: number;
}

export interface RunStewardTriageResult {
  classification: TriageClassificationT;
  rationale: string;
  new_assertions: AssertionT[];
  raw: string;
}

export async function runStewardTriage(
  input: RunStewardTriageInput,
): Promise<RunStewardTriageResult> {
  if (input.forcedHint === "INFRA") {
    return {
      classification: "INFRA",
      rationale: "forced INFRA (usertest reported tool_error)",
      new_assertions: [],
      raw: '{"classification":"INFRA","rationale":"forced INFRA"}',
    };
  }

  const template = await loadPrompt("steward-triage");
  const prompt = renderPrompt(template, {
    flow_id: input.flow_id,
    feature_id: input.feature.id,
    feature_title: input.feature.title,
    feature_spec: input.feature.spec,
    corrective_attempts: String(input.corrective_attempts),
    assertions_block: formatAssertions(input.feature),
    failures_block: formatFailures(input.failures),
    handoff_block: input.handoff ? jsonBlock(input.handoff) : "(no handoff)",
    screwdriver_block: input.screwdriver
      ? jsonBlock(input.screwdriver)
      : "(no screwdriver report)",
    usertest_block: input.usertest
      ? jsonBlock(input.usertest)
      : "(no user-test report)",
  });

  const raw = await runWithRetries({
    backend: input.backend,
    role: "steward",
    prompt,
    cwd: input.cwd,
    timeoutMs: input.timeoutMs ?? STEWARD_TIMEOUT_MS,
  });

  let parsed: unknown;
  try {
    parsed = parseStructured(raw);
  } catch (err) {
    throw new Error(`steward.triage: output not parseable: ${(err as Error).message}`);
  }
  const triage = TriageOutput.parse(parsed);
  return { ...triage, raw };
}

async function runWithRetries(args: {
  backend: AgentBackend;
  role: "steward";
  prompt: string;
  cwd: string;
  timeoutMs: number;
}): Promise<string> {
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt <= STEWARD_RETRIES; attempt++) {
    if (attempt > 0) {
      const delay = STEWARD_BACKOFFS_MS[attempt - 1] ?? 0;
      if (delay > 0) await sleep(delay);
    }
    const res = await args.backend.run({
      role: args.role,
      prompt: args.prompt,
      cwd: args.cwd,
      timeoutMs: args.timeoutMs,
    });
    if (res.ok) return res.stdout;
    lastErr = new Error(
      `steward backend failed: exit=${res.exitCode} timedOut=${res.timedOut}`,
    );
  }
  throw lastErr ?? new Error("steward: unknown failure");
}

function formatAssertions(feature: FeatureT): string {
  return feature.assertions
    .map((a) => `- [${a.id}] (${a.validator}) ${a.text}`)
    .join("\n");
}

function formatFailures(failures: AssertionResultT[]): string {
  if (failures.length === 0) return "(no assertion failures, but a tool_error or similar was reported)";
  return failures
    .map((f) => `- ${f.assertion_id}: ${f.outcome.toUpperCase()} — ${f.detail || "(no detail)"}`)
    .join("\n");
}

function jsonBlock(obj: unknown): string {
  return "```json\n" + JSON.stringify(obj, null, 2) + "\n```";
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Persist a Steward decision (markdown) to .gflow/<flow_id>/decisions/. */
export async function writeDecision(
  body: string,
  feature_id: string,
  attempt: number,
  decisionsDir: string,
): Promise<string> {
  await mkdir(decisionsDir, { recursive: true });
  const path = join(
    decisionsDir,
    `${feature_id}__attempt-${String(attempt).padStart(2, "0")}.md`,
  );
  await atomicWrite(path, body.endsWith("\n") ? body : body + "\n");
  return path;
}

/** Persist a triage record next to validator reports. */
export async function writeTriage(
  triage: RunStewardTriageResult,
  feature_id: string,
  attempt: number,
  reportsDir: string,
): Promise<string> {
  await mkdir(reportsDir, { recursive: true });
  const path = join(
    reportsDir,
    `${feature_id}__triage__attempt-${String(attempt).padStart(2, "0")}.json`,
  );
  await atomicWrite(path, JSON.stringify(triage, null, 2) + "\n");
  return path;
}

async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  await writeFile(tmp, content, "utf8");
  await rename(tmp, path);
}

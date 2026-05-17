import { writeFile, mkdir, rename } from "node:fs/promises";
import { join, dirname } from "node:path";
import type { AgentBackend } from "../adapters/backend.ts";
import type { FeatureT } from "../artifacts/contract.ts";
import type { AssertionResultT } from "../artifacts/reports.ts";
import { Handoff, type HandoffT } from "../artifacts/handoff.ts";
import { loadPrompt, renderPrompt } from "./render-prompt.ts";
import { selectAdapter } from "../gbrain/adapter.ts";
import { retrieveContext } from "../gbrain/retrieval.ts";

const WORKER_TIMEOUT_MS = 8 * 60 * 1000;
const WORKER_RETRIES = 2;
const BACKOFFS_MS = [10_000, 30_000];

export interface RunWorkerInput {
  flow_id: string;
  feature: FeatureT;
  milestone_id: string;
  target_dir: string;
  backend: AgentBackend;
  failures?: AssertionResultT[];
  attempt: number;
  /** Test hook: override the per-attempt timeout. */
  timeoutMs?: number;
  /** Test hook: skip retries when running synchronously. */
  maxRetries?: number;
  /** Test hook: shorten backoff between retries. */
  backoffsMs?: number[];
}

export interface RunWorkerResult {
  handoff: HandoffT;
  raw: string;
  attemptsUsed: number;
}

/** Run a Worker (original or corrective) with timeout + retry, return its handoff. */
export async function runWorker(input: RunWorkerInput): Promise<RunWorkerResult> {
  const template = await loadPrompt("worker");
  const memory = await retrieveContext(selectAdapter(), {
    role: "worker",
    query: `Implementation hints for feature: ${input.feature.title} — ${input.feature.spec}`,
    limit: 5,
  });
  const prompt = renderPrompt(template, {
    target_dir: input.target_dir,
    feature_id: input.feature.id,
    feature_title: input.feature.title,
    feature_spec: input.feature.spec,
    milestone_id: input.milestone_id,
    assertions_block: formatAssertions(input.feature),
    corrective_block: formatCorrective(input.failures, input.attempt),
    gbrain_context: memory.block,
  });

  const timeoutMs = input.timeoutMs ?? WORKER_TIMEOUT_MS;
  const maxRetries = input.maxRetries ?? WORKER_RETRIES;
  const backoffs = input.backoffsMs ?? BACKOFFS_MS;

  let lastErr: Error | null = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      const delay = backoffs[attempt - 1] ?? 0;
      if (delay > 0) await sleep(delay);
    }
    const res = await input.backend.run({
      role: "worker",
      prompt,
      cwd: input.target_dir,
      timeoutMs,
    });
    if (!res.ok) {
      lastErr = new Error(
        `worker backend failed: exit=${res.exitCode} timedOut=${res.timedOut} stderr=${truncate(res.stderr, 240)}`,
      );
      continue;
    }
    try {
      const handoff = parseHandoff(res.stdout, {
        flow_id: input.flow_id,
        feature_id: input.feature.id,
      });
      return { handoff, raw: res.stdout, attemptsUsed: attempt + 1 };
    } catch (err) {
      lastErr = err as Error;
      continue;
    }
  }
  throw new Error(
    `worker failed after ${maxRetries + 1} attempts: ${lastErr?.message ?? "unknown"}`,
  );
}

/** Extract a JSON handoff from a Worker's stdout. Falls back to a minimal failure record. */
export function parseHandoff(
  raw: string,
  defaults: { flow_id: string; feature_id: string },
): HandoffT {
  const obj = extractTailJson(raw);
  const candidate = {
    flow_id: defaults.flow_id,
    feature_id: defaults.feature_id,
    completed: false,
    files_touched: [] as string[],
    commands_run: [] as unknown[],
    assertions_attempted: [] as string[],
    deviations: "",
    next_worker_hints: "",
    recorded_at: new Date().toISOString(),
    ...(obj ?? {}),
  };
  return Handoff.parse(candidate);
}

function extractTailJson(raw: string): Record<string, unknown> | null {
  // 1) try fenced ```json block
  const fence = raw.match(/```json\s*([\s\S]+?)```/i);
  if (fence) {
    try {
      const parsed = JSON.parse(fence[1]!);
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      // fall through
    }
  }
  // 2) try last top-level {...} balanced block
  const last = findLastBalanced(raw, "{", "}");
  if (last) {
    try {
      const parsed = JSON.parse(last);
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      // fall through
    }
  }
  return null;
}

function findLastBalanced(s: string, open: string, close: string): string | null {
  let depth = 0;
  let start = -1;
  let lastSpan: string | null = null;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === open) {
      if (depth === 0) start = i;
      depth++;
    } else if (s[i] === close) {
      depth--;
      if (depth === 0 && start !== -1) {
        lastSpan = s.slice(start, i + 1);
        start = -1;
      }
    }
  }
  return lastSpan;
}

function formatAssertions(feature: FeatureT): string {
  return feature.assertions
    .map(
      (a, i) =>
        `${i + 1}. [${a.id}] (${a.validator}) ${a.text}\n   evidence: ${a.evidence_required}`,
    )
    .join("\n");
}

function formatCorrective(
  failures: AssertionResultT[] | undefined,
  attempt: number,
): string {
  if (!failures || failures.length === 0) return "";
  const lines = failures.map(
    (f) => `- ${f.assertion_id}: ${f.outcome.toUpperCase()} — ${f.detail || "(no detail)"}`,
  );
  return [
    "",
    `### Corrective context (attempt ${attempt})`,
    "",
    `Previous Worker output did not satisfy these assertions:`,
    "",
    ...lines,
    "",
    "Focus your fix on these. Do not rewrite passing assertions.",
  ].join("\n");
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Persist a Handoff under `.gflow/<flow_id>/handoffs/`. Atomic. */
export async function writeHandoff(
  handoff: HandoffT,
  handoffsDir: string,
  attempt: number,
): Promise<string> {
  await mkdir(handoffsDir, { recursive: true });
  const path = join(
    handoffsDir,
    `${handoff.feature_id}__attempt-${String(attempt).padStart(2, "0")}.json`,
  );
  await atomicWrite(path, JSON.stringify(handoff, null, 2) + "\n");
  return path;
}

async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  await writeFile(tmp, content, "utf8");
  await rename(tmp, path);
}

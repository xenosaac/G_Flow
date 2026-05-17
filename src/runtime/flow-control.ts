import { join } from "node:path";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import {
  ensureFlowDir,
  flowDir,
  gflowRoot,
  initialState,
  latestFlow,
  newFlowId,
  readState,
  writeState,
} from "./state.ts";
import { plan, PlannerError } from "./planner.ts";
import { writeContractYaml } from "./contract-io.ts";
import { runFlow, type RunFlowOptions } from "./runner.ts";
import type { AgentBackend } from "../adapters/backend.ts";
import { clearPause, requestPause } from "./control.ts";
import {
  GStackPlanningReviewProvider,
  PlanningReviewError,
  clarifiedBriefForPrompt,
  type ClarificationAnswer,
  type ClarificationQuestion,
  type ClarifyResult,
  type PlanningReviewProvider,
} from "./planning-review.ts";
import { emitPlanCreated } from "../gbrain/emit.ts";

export interface StartFlowInput {
  goal: string;
  backend: AgentBackend;
  clarifications?: string;
  root?: string;
  planningReviewProvider?: PlanningReviewProvider;
}

export type StartFlowResult =
  | {
      flow_id: string;
      flow_dir: string;
      status: "needs_clarification";
      questions: ClarificationQuestion[];
    }
  | ReadyPlanningResult;

export interface ReadyPlanningResult {
  flow_id: string;
  flow_dir: string;
  status: "ready";
  contract_path: string;
  milestones: number;
  features: number;
  assertions: number;
}

export async function startFlowAPI(
  input: StartFlowInput,
): Promise<StartFlowResult> {
  if (!input.goal || input.goal.trim() === "") {
    throw new Error("goal required");
  }
  const root = input.root ?? gflowRoot();
  const flowId = newFlowId();
  await ensureFlowDir(flowId, root);
  await ensureClarificationsDir(flowId, root);
  await writeState(initialState(flowId, new Date(), "clarifying"), root);
  await writeFile(
    join(flowDir(flowId, root), "goal.txt"),
    input.goal + "\n",
    "utf8",
  );
  const provider =
    input.planningReviewProvider ??
    new GStackPlanningReviewProvider({
      backend: input.backend,
      cwd: flowDir(flowId, root),
    });
  const history = input.clarifications
    ? [{ question_id: "initial", answer: input.clarifications }]
    : [];
  const intake = await provider.runIntake(input.goal, history);
  await writeIntake(flowId, intake, root);
  if (intake.status === "needs_clarification") {
    return {
      flow_id: flowId,
      flow_dir: flowDir(flowId, root),
      status: "needs_clarification",
      questions: intake.questions,
    };
  }
  return finalizePlanning({
    flow_id: flowId,
    goal: input.goal,
    intake,
    backend: input.backend,
    provider,
    root,
  });
}

export interface ClarifyFlowInput {
  flow_id: string;
  answers: ClarificationAnswer[];
  backend: AgentBackend;
  root?: string;
  planningReviewProvider?: PlanningReviewProvider;
}

export type ClarifyFlowResult =
  | {
      flow_id: string;
      status: "needs_clarification";
      questions: ClarificationQuestion[];
    }
  | ReadyPlanningResult;

export async function clarifyFlowAPI(
  input: ClarifyFlowInput,
): Promise<ClarifyFlowResult> {
  if (!input.flow_id || input.flow_id.trim() === "") {
    throw new Error("flow_id required");
  }
  if (!Array.isArray(input.answers) || input.answers.length === 0) {
    throw new Error("answers required");
  }
  const root = input.root ?? gflowRoot();
  const state = await readState(input.flow_id, root);
  if (state.phase !== "clarifying") {
    throw new Error(
      `flow ${input.flow_id} is in phase=${state.phase}; clarify requires phase=clarifying`,
    );
  }
  const goal = (await readFile(join(flowDir(input.flow_id, root), "goal.txt"), "utf8")).trim();
  if (!goal) throw new Error(`flow ${input.flow_id} has no goal.txt`);
  await appendAnswers(input.flow_id, input.answers, root);
  const history = await readAnswers(input.flow_id, root);
  const provider =
    input.planningReviewProvider ??
    new GStackPlanningReviewProvider({
      backend: input.backend,
      cwd: flowDir(input.flow_id, root),
    });
  const intake = await provider.runIntake(goal, history);
  await writeIntake(input.flow_id, intake, root);
  if (intake.status === "needs_clarification") {
    return {
      flow_id: input.flow_id,
      status: "needs_clarification",
      questions: intake.questions,
    };
  }
  return finalizePlanning({
    flow_id: input.flow_id,
    goal,
    intake,
    backend: input.backend,
    provider,
    root,
  });
}

export interface ResumeFlowInput {
  flow_id?: string;
  backend: AgentBackend;
  target_dir?: string;
  target_url?: string;
  root?: string;
  /** Test hook to short-circuit deep runs. */
  runFlowOverride?: (opts: RunFlowOptions) => ReturnType<typeof runFlow>;
}

export interface ResumeFlowResult {
  flow_id: string;
  status: "complete" | "needs_human" | "awaiting_approval" | "paused";
  iterations: number;
  reason?: string;
}

export async function resumeFlowAPI(
  input: ResumeFlowInput,
): Promise<ResumeFlowResult> {
  const root = input.root ?? gflowRoot();
  let flowId = input.flow_id;
  if (!flowId) {
    const latest = await latestFlow((s) => s.phase !== "complete", root);
    if (!latest) {
      throw new Error("no resumable flow");
    }
    flowId = latest.flow_id;
  }
  const targetDir =
    input.target_dir ??
    process.env.GFLOW_TARGET_DIR ??
    join(process.cwd(), "..", "demo-target");
  const targetUrl =
    input.target_url ??
    process.env.GFLOW_TARGET_URL ??
    "http://localhost:3000";

  const runOpts: RunFlowOptions = {
    flow_id: flowId,
    target_dir: targetDir,
    target_url: targetUrl,
    backend: input.backend,
    approve: true,
    root,
  };
  await clearPause(flowId, root);
  const runner = input.runFlowOverride ?? runFlow;
  const r = await runner(runOpts);
  return {
    flow_id: flowId,
    status: r.status,
    iterations: r.iterations,
    reason: r.reason,
  };
}

export interface PauseFlowInput {
  flow_id?: string;
  reason?: string;
  root?: string;
}

export interface PauseFlowResult {
  flow_id: string;
  status: "paused" | "pause_requested";
}

export async function pauseFlowAPI(
  input: PauseFlowInput = {},
): Promise<PauseFlowResult> {
  const root = input.root ?? gflowRoot();
  let flowId = input.flow_id;
  if (!flowId) {
    const latest = await latestFlow(
      (s) => s.phase !== "complete" && s.phase !== "needs_human",
      root,
    );
    if (!latest) throw new Error("no pausable flow");
    flowId = latest.flow_id;
  }
  await requestPause(flowId, input.reason, root);
  const state = await readState(flowId, root);
  if (state.phase === "executing") {
    await writeState(
      { ...state, phase: "paused", updated_at: new Date().toISOString() },
      root,
    );
    return { flow_id: flowId, status: "paused" };
  }
  return { flow_id: flowId, status: "pause_requested" };
}

export interface ReplanFlowInput {
  flow_id: string;
  backend: AgentBackend;
  clarifications: string;
  root?: string;
}

export interface ReplanFlowResult {
  flow_id: string;
  contract_path: string;
  milestones: number;
  features: number;
  assertions: number;
  /** Rev counter: how many times contract.yaml has been rewritten for this flow. */
  revision: number;
}

/**
 * Re-run the Planner against an existing flow in `phase === "planning"`.
 * Preserves the flow_id and goal; rewrites contract.yaml in place. Used by
 * the Console's "auto-revise on every message" behavior — every user
 * message in plan mode passes the chat history as `clarifications`.
 *
 * Rejects flows not in planning (would silently overwrite an executing
 * contract otherwise).
 */
export async function replanFlowAPI(
  input: ReplanFlowInput,
): Promise<ReplanFlowResult> {
  if (!input.flow_id || input.flow_id.trim() === "") {
    throw new Error("flow_id required");
  }
  const root = input.root ?? gflowRoot();
  const state = await readState(input.flow_id, root).catch(() => null);
  if (!state) {
    throw new Error(`flow ${input.flow_id} not found`);
  }
  if (state.phase !== "planning") {
    throw new Error(
      `flow ${input.flow_id} is in phase=${state.phase}; replan requires phase=planning`,
    );
  }
  // Read the original goal that was written when the flow was minted.
  const goalPath = join(flowDir(input.flow_id, root), "goal.txt");
  const { readFile } = await import("node:fs/promises");
  const goal = (await readFile(goalPath, "utf8")).trim();
  if (!goal) throw new Error(`flow ${input.flow_id} has no goal.txt`);

  const { contract } = await plan({
    flow_id: input.flow_id,
    goal,
    clarifications: input.clarifications,
    cwd: flowDir(input.flow_id, root),
    backend: input.backend,
  });
  const contractPath = join(flowDir(input.flow_id, root), "contract.yaml");
  await writeContractYaml(contract, contractPath);
  emitPlanCreated({
    flow_id: input.flow_id,
    goal,
    contract,
    target_dir: process.env.GFLOW_TARGET_DIR,
    target_url: process.env.GFLOW_TARGET_URL,
  });

  // Touch state so any UI watching mtimes sees the revision.
  await writeState({ ...state, updated_at: new Date().toISOString() }, root);

  const features = contract.milestones.reduce(
    (s, m) => s + m.features.length,
    0,
  );
  const assertions = contract.milestones.reduce(
    (s, m) => s + m.features.reduce((t, f) => t + f.assertions.length, 0),
    0,
  );
  // Revision counter: counts unique (flow_id) replan calls. We don't persist
  // a counter on disk; the UI tracks it locally if it wants. For now we just
  // return 0 to signal "the helper itself doesn't track revisions" — the API
  // route layer can supply its own counter if needed.
  return {
    flow_id: input.flow_id,
    contract_path: contractPath,
    milestones: contract.milestones.length,
    features,
    assertions,
    revision: 0,
  };
}

export { PlannerError };

async function finalizePlanning(input: {
  flow_id: string;
  goal: string;
  intake: Extract<ClarifyResult, { status: "ready" }>;
  backend: AgentBackend;
  provider: PlanningReviewProvider;
  root: string;
}): Promise<ReadyPlanningResult> {
  const cwd = flowDir(input.flow_id, input.root);
  const clarified = clarifiedBriefForPrompt(input.intake);
  const { contract: draft } = await plan({
    flow_id: input.flow_id,
    goal: input.goal,
    clarifications: clarified,
    cwd,
    backend: input.backend,
  });
  const reviewed = await input.provider.runEngineeringReview(
    input.goal,
    clarified,
    draft,
  );
  if (reviewed.status === "issues") {
    throw new PlanningReviewError("GStack engineering review rejected the contract", reviewed.issues);
  }
  const contractPath = join(cwd, "contract.yaml");
  await writeContractYaml(reviewed.contract, contractPath);
  emitPlanCreated({
    flow_id: input.flow_id,
    goal: input.goal,
    contract: reviewed.contract,
    target_dir: process.env.GFLOW_TARGET_DIR,
    target_url: process.env.GFLOW_TARGET_URL,
  });
  const state = await readState(input.flow_id, input.root);
  await writeState(
    { ...state, phase: "planning", updated_at: new Date().toISOString() },
    input.root,
  );
  const features = reviewed.contract.milestones.reduce(
    (s, m) => s + m.features.length,
    0,
  );
  const assertions = reviewed.contract.milestones.reduce(
    (s, m) => s + m.features.reduce((t, f) => t + f.assertions.length, 0),
    0,
  );
  return {
    flow_id: input.flow_id,
    flow_dir: flowDir(input.flow_id, input.root),
    status: "ready",
    contract_path: contractPath,
    milestones: reviewed.contract.milestones.length,
    features,
    assertions,
  };
}

function clarificationsDir(flowId: string, root: string): string {
  return join(flowDir(flowId, root), "clarifications");
}

async function ensureClarificationsDir(flowId: string, root: string): Promise<void> {
  await mkdir(clarificationsDir(flowId, root), { recursive: true });
}

async function nextJsonPath(
  flowId: string,
  root: string,
  prefix: string,
): Promise<string> {
  const dir = clarificationsDir(flowId, root);
  await mkdir(dir, { recursive: true });
  const files = await readdir(dir).catch(() => []);
  const n =
    files.filter((f) => f.startsWith(`${prefix}-`) && f.endsWith(".json"))
      .length + 1;
  return join(dir, `${prefix}-${String(n).padStart(2, "0")}.json`);
}

async function writeIntake(
  flowId: string,
  result: ClarifyResult,
  root: string,
): Promise<void> {
  const path = await nextJsonPath(flowId, root, "intake");
  await writeFile(
    path,
    JSON.stringify({ recorded_at: new Date().toISOString(), ...result }, null, 2) + "\n",
    "utf8",
  );
}

async function appendAnswers(
  flowId: string,
  answers: ClarificationAnswer[],
  root: string,
): Promise<void> {
  const path = await nextJsonPath(flowId, root, "answers");
  await writeFile(
    path,
    JSON.stringify({ recorded_at: new Date().toISOString(), answers }, null, 2) + "\n",
    "utf8",
  );
}

async function readAnswers(
  flowId: string,
  root: string,
): Promise<ClarificationAnswer[]> {
  const dir = clarificationsDir(flowId, root);
  const files = (await readdir(dir).catch(() => []))
    .filter((f) => f.startsWith("answers-") && f.endsWith(".json"))
    .sort();
  const answers: ClarificationAnswer[] = [];
  for (const file of files) {
    try {
      const raw = JSON.parse(await readFile(join(dir, file), "utf8"));
      if (Array.isArray(raw.answers)) {
        for (const a of raw.answers) {
          if (
            a &&
            typeof a.question_id === "string" &&
            typeof a.answer === "string"
          ) {
            answers.push({ question_id: a.question_id, answer: a.answer });
          }
        }
      }
    } catch {
      // Ignore malformed old clarification artifacts.
    }
  }
  return answers;
}

export { PlanningReviewError };

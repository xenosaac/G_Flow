import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import {
  ensureFlowDir,
  flowDir,
  gflowRoot,
  initialState,
  latestFlow,
  newFlowId,
  writeState,
} from "./state.ts";
import { plan, PlannerError } from "./planner.ts";
import { writeContractYaml } from "./contract-io.ts";
import { runFlow, type RunFlowOptions } from "./runner.ts";
import type { AgentBackend } from "../adapters/backend.ts";

export interface StartFlowInput {
  goal: string;
  backend: AgentBackend;
  clarifications?: string;
  root?: string;
}

export interface StartFlowResult {
  flow_id: string;
  flow_dir: string;
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
  await writeState(initialState(flowId), root);
  await writeFile(
    join(flowDir(flowId, root), "goal.txt"),
    input.goal + "\n",
    "utf8",
  );
  const { contract } = await plan({
    flow_id: flowId,
    goal: input.goal,
    clarifications: input.clarifications,
    cwd: flowDir(flowId, root),
    backend: input.backend,
  });
  const contractPath = join(flowDir(flowId, root), "contract.yaml");
  await writeContractYaml(contract, contractPath);
  const features = contract.milestones.reduce(
    (s, m) => s + m.features.length,
    0,
  );
  const assertions = contract.milestones.reduce(
    (s, m) => s + m.features.reduce((t, f) => t + f.assertions.length, 0),
    0,
  );
  return {
    flow_id: flowId,
    flow_dir: flowDir(flowId, root),
    contract_path: contractPath,
    milestones: contract.milestones.length,
    features,
    assertions,
  };
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
  status: "complete" | "needs_human" | "awaiting_approval";
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
  const runner = input.runFlowOverride ?? runFlow;
  const r = await runner(runOpts);
  return {
    flow_id: flowId,
    status: r.status,
    iterations: r.iterations,
    reason: r.reason,
  };
}

export { PlannerError };

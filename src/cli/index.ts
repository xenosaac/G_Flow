import { writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import {
  ensureFlowDir,
  flowDir,
  initialState,
  latestFlow,
  newFlowId,
  writeState,
} from "../runtime/state.ts";
import { plan, PlannerError } from "../runtime/planner.ts";
import { writeContractYaml } from "../runtime/contract-io.ts";
import { runFlow } from "../runtime/runner.ts";
import {
  defaultBackend,
  UnknownBackendError,
} from "../adapters/select.ts";
import type { AgentBackend } from "../adapters/backend.ts";

const HELP = `gflow — orchestration system for coding agents

Usage:
  gflow start "<goal>"   Begin a new flow from a user goal
  gflow status           Show status of the latest flow
  gflow resume           Resume the latest non-complete flow (Phase 2 loop)
  gflow approve          Alias for resume — explicit "I reviewed the contract"
  gflow help             Show this help

Environment:
  GFLOW_TARGET_DIR       Worker sandbox dir (default: ../demo-target)
  GFLOW_TARGET_URL       URL for user-test validator (default: http://localhost:3000)
  GFLOW_ROOT             Runtime artifact root (default: ./.gflow)
  GFLOW_BACKEND          planner/worker backend: claude-code (default) | codex | opencloud | none
  GFLOW_CLAUDE_BIN       path to claude CLI (default: "claude")
  GFLOW_CODEX_BIN        path to codex CLI (default: "codex")
`;

export interface CmdStartOptions {
  backend?: AgentBackend | null;
  runPlanner?: boolean;
  clarifications?: string;
}

export async function cmdStart(goal: string, options: CmdStartOptions = {}): Promise<number> {
  if (!goal || goal.trim() === "") {
    console.error('gflow: "start" requires a non-empty goal');
    console.error('Usage: gflow start "<goal>"');
    return 64;
  }
  const flowId = newFlowId();
  await ensureFlowDir(flowId);
  const state = initialState(flowId);
  await writeState(state);
  await writeFile(join(flowDir(flowId), "goal.txt"), goal + "\n", "utf8");
  console.log(`gflow: created flow ${flowId}`);
  console.log(`       goal:  ${goal}`);
  console.log(`       dir:   ${flowDir(flowId)}`);

  if (options.runPlanner !== false && options.backend) {
    console.log(`       planner: invoking ${options.backend.name}…`);
    try {
      const { contract } = await plan({
        flow_id: flowId,
        goal,
        clarifications: options.clarifications,
        cwd: flowDir(flowId),
        backend: options.backend,
      });
      const contractPath = join(flowDir(flowId), "contract.yaml");
      await writeContractYaml(contract, contractPath);
      const featureCount = contract.milestones.reduce((s, m) => s + m.features.length, 0);
      const assertionCount = contract.milestones.reduce(
        (s, m) => s + m.features.reduce((t, f) => t + f.assertions.length, 0),
        0,
      );
      console.log(
        `       contract: ${contract.milestones.length} milestones / ${featureCount} features / ${assertionCount} assertions`,
      );
      console.log(`       written: ${contractPath}`);
      console.log(`       phase: planning (review contract, then \`gflow resume\`)`);
      return 0;
    } catch (err) {
      if (err instanceof PlannerError) {
        console.error(`gflow: planner failed self-check (G1)`);
        console.error(`       ${err.message}`);
        for (const issue of err.issues) console.error(`       - ${issue}`);
        return 1;
      }
      throw err;
    }
  } else {
    console.log(`       phase: planning (no backend wired; supply --backend or set GFLOW_BACKEND)`);
  }
  return 0;
}

export async function cmdStatus(): Promise<number> {
  const latest = await latestFlow();
  if (!latest) {
    console.log('gflow: no flows yet. Run `gflow start "<goal>"`.');
    return 0;
  }
  console.log(`flow_id:            ${latest.flow_id}`);
  console.log(`phase:              ${latest.phase}`);
  console.log(`current_milestone:  ${latest.current_milestone ?? "—"}`);
  console.log(`current_feature:    ${latest.current_feature ?? "—"}`);
  console.log(`current_step:       ${latest.current_step ?? "—"}`);
  const ca = Object.entries(latest.corrective_attempts);
  if (ca.length) {
    console.log(`corrective_attempts:`);
    for (const [k, v] of ca) console.log(`  ${k}: ${v}`);
  }
  console.log(
    `counters:           llm=${latest.counters.llm_calls} tok_in=${latest.counters.tokens_in} tok_out=${latest.counters.tokens_out} usd=${latest.counters.usd_spent.toFixed(4)}`,
  );
  console.log(`started_at:         ${latest.started_at}`);
  console.log(`updated_at:         ${latest.updated_at}`);
  return 0;
}

export interface CmdResumeOptions {
  backend?: AgentBackend | null;
}

export async function cmdResume(options: CmdResumeOptions = {}): Promise<number> {
  const latest = await latestFlow((s) => s.phase !== "complete");
  if (!latest) {
    console.log("gflow: no resumable flow.");
    return 0;
  }
  const contractPath = join(flowDir(latest.flow_id), "contract.yaml");
  const hasContract = await fileExists(contractPath);
  if (!hasContract) {
    console.log(
      `gflow: flow ${latest.flow_id} exists but contract.yaml is missing. Run \`gflow start "<goal>"\` with a configured backend.`,
    );
    return 0;
  }
  const backend =
    options.backend === undefined ? await defaultBackend() : options.backend;
  if (!backend) {
    console.log(
      `gflow: flow ${latest.flow_id} is ready to resume; set GFLOW_BACKEND=claude-code (or pass --backend) to drive Phase 2.`,
    );
    return 0;
  }

  const targetDir =
    process.env.GFLOW_TARGET_DIR ?? join(process.cwd(), "..", "demo-target");
  const targetUrl =
    process.env.GFLOW_TARGET_URL ?? "http://localhost:3000";

  console.log(`gflow: resuming ${latest.flow_id}`);
  console.log(`       backend:    ${backend.name}`);
  console.log(`       target_dir: ${targetDir}`);
  console.log(`       target_url: ${targetUrl}`);

  const r = await runFlow({
    flow_id: latest.flow_id,
    target_dir: targetDir,
    target_url: targetUrl,
    backend,
    approve: true,
  });
  console.log(
    `gflow: ${r.status}${r.reason ? ` — ${r.reason}` : ""} (${r.iterations} iterations)`,
  );
  return r.status === "needs_human" ? 1 : 0;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

export {
  UnknownBackendError,
  KNOWN_BACKENDS,
  defaultBackend,
  selectBackend,
  type KnownBackend,
} from "../adapters/select.ts";

export async function main(argv: string[]): Promise<number> {
  const cmd = argv[0];

  switch (cmd) {
    case "start": {
      const goal = argv.slice(1).join(" ");
      let backend: AgentBackend | null;
      try {
        backend = await defaultBackend();
      } catch (err) {
        if (err instanceof UnknownBackendError) {
          console.error(`gflow: ${err.message}`);
          return 64;
        }
        throw err;
      }
      return cmdStart(goal, { backend, runPlanner: backend !== null });
    }
    case "status":
      return cmdStatus();
    case "resume": {
      let backend: AgentBackend | null;
      try {
        backend = await defaultBackend();
      } catch (err) {
        if (err instanceof UnknownBackendError) {
          console.error(`gflow: ${err.message}`);
          return 64;
        }
        throw err;
      }
      return cmdResume({ backend });
    }
    case "approve": {
      let backend: AgentBackend | null;
      try {
        backend = await defaultBackend();
      } catch (err) {
        if (err instanceof UnknownBackendError) {
          console.error(`gflow: ${err.message}`);
          return 64;
        }
        throw err;
      }
      return cmdResume({ backend });
    }
    case undefined:
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(HELP);
      return 0;
    default:
      console.error(`gflow: unknown command "${cmd}"`);
      process.stdout.write(HELP);
      return 64;
  }
}

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
import { pauseFlowAPI } from "../runtime/flow-control.ts";
import {
  defaultBackend,
  UnknownBackendError,
} from "../adapters/select.ts";
import type { AgentBackend } from "../adapters/backend.ts";
import { emitPlanCreated } from "../gbrain/emit.ts";
import { enqueueSnapshot, flushGbrain } from "../gbrain/client.ts";
import { selectAdapter, type GbrainAdapter } from "../gbrain/adapter.ts";
import { buildPlanCreated } from "../gbrain/snapshot.ts";

const HELP = `gflow — orchestration system for coding agents

Usage:
  gflow start "<goal>"   Begin a new flow from a user goal
  gflow status           Show status of the latest flow
  gflow pause            Request pause at the next checkpoint
  gflow resume           Resume the latest non-complete flow (Phase 2 loop)
  gflow approve          Alias for resume — explicit "I reviewed the contract"
  gflow help             Show this help

Environment:
  GFLOW_TARGET_DIR       Worker sandbox dir (default: ../demo-target)
  GFLOW_TARGET_URL       URL for user-test validator (default: http://localhost:3000)
  GFLOW_ROOT             Runtime artifact root (default: ./.gflow)
  GFLOW_BACKEND          planner/worker backend: claude-code (default) | codex | none
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
      emitPlanCreated({
        flow_id: flowId,
        goal,
        contract,
        target_dir: process.env.GFLOW_TARGET_DIR,
        target_url: process.env.GFLOW_TARGET_URL,
      });
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

export async function cmdPause(): Promise<number> {
  try {
    const r = await pauseFlowAPI({ reason: "requested from CLI" });
    console.log(`gflow: ${r.status} ${r.flow_id}`);
    return 0;
  } catch (err) {
    console.error(`gflow: pause failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

export async function cmdGbrain(args: string[]): Promise<number> {
  const sub = args[0];
  const rest = args.slice(1);
  const adapter = selectAdapter();
  switch (sub) {
    case "health":
      return cmdGbrainHealth(adapter, rest);
    case "drain":
      return cmdGbrainDrain(adapter, rest);
    case "query":
      return cmdGbrainQuery(adapter, rest);
    case "seed-snapshot":
      return cmdGbrainSeedSnapshot(rest);
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log("gflow gbrain — GBrain integration commands");
      console.log("  gflow gbrain health [--json]");
      console.log("  gflow gbrain drain [--flow=<id>]");
      console.log('  gflow gbrain query "<q>" [--limit=N] [--json]');
      console.log('  gflow gbrain seed-snapshot --kind=plan_created --flow=<id> [--goal=<g>]   (admin/smoke-test)');
      return 0;
    default:
      console.error(`gflow gbrain: unknown subcommand "${sub}"`);
      return 64;
  }
}

async function cmdGbrainHealth(adapter: GbrainAdapter, args: string[]): Promise<number> {
  const json = args.includes("--json");
  const health = await adapter.health();
  if (json) {
    console.log(JSON.stringify(health, null, 2));
  } else {
    console.log(`mode:      ${health.mode}`);
    console.log(`ok:        ${health.ok}`);
    console.log(`reason:    ${health.reason}`);
    console.log(`source:    ${health.source_id}`);
    if (health.detail) console.log(`detail:    ${health.detail}`);
    if (health.warnings.length > 0) {
      console.log(`warnings:`);
      for (const w of health.warnings) console.log(`  - ${w}`);
    }
    console.log(`checked:   ${health.checked_at}`);
  }
  if (
    health.reason === "misconfigured" ||
    health.reason === "unknown_mode"
  ) {
    return 64;
  }
  return health.ok ? 0 : 1;
}

async function cmdGbrainDrain(adapter: GbrainAdapter, args: string[]): Promise<number> {
  const flowId = getFlag(args, "--flow") ?? undefined;
  const result = await adapter.drainOutbox(flowId);
  console.log(JSON.stringify(result, null, 2));
  if (
    result.errors.length === 1 &&
    result.errors[0]?.message.startsWith("GBrain misconfigured:")
  ) {
    return 64;
  }
  return result.ok ? 0 : 1;
}

async function cmdGbrainQuery(adapter: GbrainAdapter, args: string[]): Promise<number> {
  const json = args.includes("--json");
  const limit = Number(getFlag(args, "--limit") ?? "5") || 5;
  const positional = args.filter((a) => !a.startsWith("--"));
  const q = positional.join(" ").trim();
  if (!q) {
    console.error('gflow gbrain query: missing query string. Usage: gflow gbrain query "<q>"');
    return 64;
  }
  if (adapter.mode === "off") {
    console.error("gflow gbrain query: mode is off; set GBRAIN_MODE=local-cli or mcp-http.");
    return 1;
  }
  const result = await adapter.queryContext(q, { limit });
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }
  if (result.results.length === 0) {
    console.log("(no results)");
    return 0;
  }
  for (const r of result.results) {
    console.log(`${r.slug}  (score=${r.score.toFixed(2)})`);
    console.log(r.text.slice(0, 400));
    console.log("---");
  }
  return 0;
}

async function cmdGbrainSeedSnapshot(args: string[]): Promise<number> {
  const kind = getFlag(args, "--kind");
  const flowId = getFlag(args, "--flow");
  const goal = getFlag(args, "--goal") ?? "smoke-test goal";
  if (kind !== "plan_created") {
    console.error(`gflow gbrain seed-snapshot: only --kind=plan_created supported in V2`);
    return 64;
  }
  if (!flowId) {
    console.error("gflow gbrain seed-snapshot: --flow=<id> required");
    return 64;
  }
  await ensureFlowDir(flowId);
  // Synthetic minimal contract so buildPlanCreated has something to summarize.
  const contract = {
    flow_id: flowId,
    goal,
    created_at: new Date().toISOString(),
    milestones: [
      {
        id: "M-001",
        title: "Smoke milestone",
        endpoint_criteria: "smoke test",
        features: [
          {
            id: "F-001",
            title: "Smoke feature",
            spec: "Synthetic feature for the gbrain smoke test.",
            assertions: [
              {
                id: "A-001-001",
                text: "smoke assertion",
                validator: "screwdriver" as const,
                evidence_required: "n/a",
                status: "pending" as const,
                origin: "original" as const,
                attempts: [],
                check: { kind: "file_exists" as const, path: "index.html" },
              },
            ],
          },
        ],
      },
    ],
  };
  const source_id = (process.env.GBRAIN_SOURCE_ID ?? "").trim() || "gflow";
  enqueueSnapshot(
    buildPlanCreated({
      flow_id: flowId,
      source_id,
      goal,
      contract,
    }),
  );
  console.log(`gflow gbrain seed-snapshot: queued plan_created for ${flowId}`);
  return 0;
}

function getFlag(args: string[], name: string): string | null {
  for (const a of args) {
    if (a === name) return "";
    if (a.startsWith(name + "=")) return a.slice(name.length + 1);
  }
  return null;
}

export {
  UnknownBackendError,
  KNOWN_BACKENDS,
  defaultBackend,
  selectBackend,
  type KnownBackend,
} from "../adapters/select.ts";

export async function main(argv: string[]): Promise<number> {
  try {
    return await dispatch(argv);
  } finally {
    // MUST flush before process.exit — promise chains aren't durability.
    await flushGbrain();
  }
}

async function dispatch(argv: string[]): Promise<number> {
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
    case "pause":
      return cmdPause();
    case "gbrain":
      return cmdGbrain(argv.slice(1));
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

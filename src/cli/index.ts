import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ensureFlowDir,
  flowDir,
  initialState,
  latestFlow,
  newFlowId,
  writeState,
} from "../runtime/state.ts";

const HELP = `gflow — orchestration system for coding agents

Usage:
  gflow start "<goal>"   Begin a new flow from a user goal
  gflow status           Show status of the latest flow
  gflow resume           Resume the latest non-complete flow
  gflow help             Show this help

Environment:
  GFLOW_TARGET_DIR       Worker sandbox dir (default: ../demo-target)
  GFLOW_ROOT             Runtime artifact root (default: ./.gflow)
`;

export async function cmdStart(goal: string): Promise<number> {
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
  console.log(`       phase: planning (Planner runs in M3)`);
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

export async function cmdResume(): Promise<number> {
  const latest = await latestFlow((s) => s.phase !== "complete");
  if (!latest) {
    console.log("gflow: no resumable flow.");
    return 0;
  }
  console.log(`gflow: resuming flow ${latest.flow_id} (phase=${latest.phase})`);
  console.log("       runtime loop wires up in M4-M5; this is a no-op stub.");
  return 0;
}

export async function main(argv: string[]): Promise<number> {
  const cmd = argv[0];

  switch (cmd) {
    case "start":
      return cmdStart(argv.slice(1).join(" "));
    case "status":
      return cmdStatus();
    case "resume":
      return cmdResume();
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

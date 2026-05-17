import { readFile, writeFile, rename, mkdir, readdir, stat } from "node:fs/promises";
import { join, dirname } from "node:path";
import { FlowState, type FlowStateT } from "../artifacts/state.ts";

export function gflowRoot(): string {
  return process.env.GFLOW_ROOT ?? join(process.cwd(), ".gflow");
}

export function flowDir(flowId: string, root: string = gflowRoot()): string {
  return join(root, flowId);
}

export function stateFile(flowId: string, root: string = gflowRoot()): string {
  return join(flowDir(flowId, root), "state.json");
}

export async function ensureFlowDir(flowId: string, root: string = gflowRoot()): Promise<void> {
  const base = flowDir(flowId, root);
  await mkdir(join(base, "features"), { recursive: true });
  await mkdir(join(base, "handoffs"), { recursive: true });
  await mkdir(join(base, "reports"), { recursive: true });
  await mkdir(join(base, "decisions"), { recursive: true });
}

export async function readState(flowId: string, root: string = gflowRoot()): Promise<FlowStateT> {
  const raw = await readFile(stateFile(flowId, root), "utf8");
  return FlowState.parse(JSON.parse(raw));
}

export async function writeState(state: FlowStateT, root: string = gflowRoot()): Promise<void> {
  const validated = FlowState.parse({ ...state, updated_at: new Date().toISOString() });
  const path = stateFile(validated.flow_id, root);
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  await writeFile(tmp, JSON.stringify(validated, null, 2) + "\n", "utf8");
  await rename(tmp, path);
}

export async function listFlows(root: string = gflowRoot()): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

export async function latestFlow(
  filter?: (s: FlowStateT) => boolean,
  root: string = gflowRoot(),
): Promise<FlowStateT | null> {
  const ids = await listFlows(root);
  let best: { state: FlowStateT; mtime: number } | null = null;
  for (const id of ids) {
    try {
      const path = stateFile(id, root);
      const st = await stat(path);
      const state = await readState(id, root);
      if (filter && !filter(state)) continue;
      if (!best || st.mtimeMs > best.mtime) best = { state, mtime: st.mtimeMs };
    } catch {
      // skip broken state files
    }
  }
  return best?.state ?? null;
}

export function newFlowId(now: Date = new Date(), randomSeq?: number): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  const seq = (randomSeq ?? Math.floor(Math.random() * 10000)).toString().padStart(4, "0");
  return `f_${y}_${m}_${d}_${seq}`;
}

export function initialState(
  flowId: string,
  now: Date = new Date(),
  phase: FlowStateT["phase"] = "planning",
): FlowStateT {
  const iso = now.toISOString();
  return {
    flow_id: flowId,
    phase,
    current_milestone: null,
    current_feature: null,
    current_step: null,
    corrective_attempts: {},
    counters: { llm_calls: 0, tokens_in: 0, tokens_out: 0, usd_spent: 0 },
    started_at: iso,
    updated_at: iso,
  };
}

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import YAML from "yaml";
import {
  flowDir,
  gflowRoot,
  latestFlow,
  listFlows,
} from "../../runtime/state.ts";
import { Contract, type ContractT } from "../../artifacts/contract.ts";
import { Handoff, type HandoffT } from "../../artifacts/handoff.ts";
import {
  ValidatorReport,
  type ValidatorReportT,
} from "../../artifacts/reports.ts";
import type { FlowStateT } from "../../artifacts/state.ts";

export interface FlowSnapshot {
  flow_id: string;
  goal: string;
  state: FlowStateT;
  contract: ContractT | null;
  latest: {
    handoff: HandoffT | null;
    screwdriver: ValidatorReportT | null;
    usertest: ValidatorReportT | null;
    triage: { classification: string; rationale: string } | null;
  };
  attempt_history: {
    [feature_id: string]: {
      attempts: number;
      latest_failures: string[];
    };
  };
  needs_human_reason: string | null;
}

export async function readLatestSnapshot(): Promise<FlowSnapshot | null> {
  const root = gflowRoot();
  const state = await latestFlow(undefined, root);
  if (!state) return null;
  return readSnapshot(state.flow_id);
}

export async function readSnapshot(flow_id: string): Promise<FlowSnapshot | null> {
  const root = gflowRoot();
  const dir = flowDir(flow_id, root);

  let state: FlowStateT;
  try {
    const raw = await readFile(join(dir, "state.json"), "utf8");
    state = JSON.parse(raw);
  } catch {
    return null;
  }

  let goal = "";
  try {
    goal = (await readFile(join(dir, "goal.txt"), "utf8")).trim();
  } catch {
    // ok if missing
  }

  let contract: ContractT | null = null;
  try {
    const raw = await readFile(join(dir, "contract.yaml"), "utf8");
    contract = Contract.parse(YAML.parse(raw));
  } catch {
    // ok if missing (Phase 1 not run yet)
  }

  const featureId = state.current_feature;
  const handoffsDir = join(dir, "handoffs");
  const reportsDir = join(dir, "reports");

  const latest = {
    handoff: featureId ? await readLatestHandoff(handoffsDir, featureId) : null,
    screwdriver: featureId
      ? await readLatestValidator(reportsDir, featureId, "screwdriver")
      : null,
    usertest: featureId
      ? await readLatestValidator(reportsDir, featureId, "usertest")
      : null,
    triage: featureId ? await readLatestTriage(reportsDir, featureId) : null,
  };

  const attempt_history: FlowSnapshot["attempt_history"] = {};
  if (contract) {
    for (const m of contract.milestones) {
      for (const f of m.features) {
        const handoffCount = await countAttempts(handoffsDir, f.id, "");
        const failures = await collectFailures(reportsDir, f.id);
        attempt_history[f.id] = {
          attempts: handoffCount,
          latest_failures: failures,
        };
      }
    }
  }

  // needs_human_reason: when state.phase=needs_human, derive a human-readable
  // reason from the latest triage classification + raw stderr tails.
  let needs_human_reason: string | null = null;
  if (state.phase === "needs_human") {
    if (latest.triage) {
      needs_human_reason =
        latest.triage.classification === "INFRA"
          ? `Steward classified failure as INFRA. ${latest.triage.rationale ?? ""}`.trim()
          : `G3 cap (5 corrective attempts) reached on ${featureId ?? "unknown feature"}. Latest triage: ${latest.triage.classification}.`;
    } else if (latest.usertest?.status === "tool_error") {
      needs_human_reason =
        `UserTest reported tool_error (INFRA). ${latest.usertest.raw_stderr_tail || ""}`.trim();
    } else {
      needs_human_reason = "Flow halted for human review.";
    }
  }

  return {
    flow_id,
    goal,
    state,
    contract,
    latest,
    attempt_history,
    needs_human_reason,
  };
}

async function readLatestHandoff(
  handoffsDir: string,
  feature_id: string,
): Promise<HandoffT | null> {
  try {
    const files = (await readdir(handoffsDir))
      .filter(
        (f) =>
          f.startsWith(`${feature_id}__attempt-`) && f.endsWith(".json"),
      )
      .sort()
      .reverse();
    if (files.length === 0) return null;
    const raw = await readFile(join(handoffsDir, files[0]!), "utf8");
    return Handoff.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

async function readLatestValidator(
  reportsDir: string,
  feature_id: string,
  validator: "screwdriver" | "usertest",
): Promise<ValidatorReportT | null> {
  try {
    const files = (await readdir(reportsDir))
      .filter(
        (f) =>
          f.startsWith(`${feature_id}__${validator}__attempt-`) &&
          f.endsWith(".json"),
      )
      .sort()
      .reverse();
    if (files.length === 0) return null;
    const raw = await readFile(join(reportsDir, files[0]!), "utf8");
    return ValidatorReport.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

async function readLatestTriage(
  reportsDir: string,
  feature_id: string,
): Promise<{ classification: string; rationale: string } | null> {
  try {
    const files = (await readdir(reportsDir))
      .filter(
        (f) =>
          f.startsWith(`${feature_id}__triage__attempt-`) &&
          f.endsWith(".json"),
      )
      .sort()
      .reverse();
    if (files.length === 0) return null;
    const raw = await readFile(join(reportsDir, files[0]!), "utf8");
    const parsed = JSON.parse(raw);
    return {
      classification: parsed.classification ?? "UNKNOWN",
      rationale: parsed.rationale ?? "",
    };
  } catch {
    return null;
  }
}

async function countAttempts(
  handoffsDir: string,
  feature_id: string,
  _unused: string,
): Promise<number> {
  try {
    const files = (await readdir(handoffsDir)).filter(
      (f) => f.startsWith(`${feature_id}__attempt-`) && f.endsWith(".json"),
    );
    return files.length;
  } catch {
    return 0;
  }
}

async function collectFailures(
  reportsDir: string,
  feature_id: string,
): Promise<string[]> {
  try {
    const files = (await readdir(reportsDir))
      .filter(
        (f) =>
          (f.includes(`${feature_id}__screwdriver`) ||
            f.includes(`${feature_id}__usertest`)) &&
          f.endsWith(".json"),
      )
      .sort()
      .reverse()
      .slice(0, 2);
    const out: string[] = [];
    for (const f of files) {
      const raw = await readFile(join(reportsDir, f), "utf8");
      const r: ValidatorReportT = ValidatorReport.parse(JSON.parse(raw));
      for (const ar of r.assertion_results) {
        if (ar.outcome === "fail")
          out.push(`${ar.assertion_id}: ${ar.detail}`);
      }
    }
    return out;
  } catch {
    return [];
  }
}

export async function snapshotMtime(flow_id: string): Promise<number> {
  const root = gflowRoot();
  const dir = flowDir(flow_id, root);
  let max = 0;
  for (const sub of ["state.json", "contract.yaml", "handoffs", "reports", "decisions"]) {
    try {
      const s = await stat(join(dir, sub));
      if (s.isDirectory()) {
        try {
          const files = await readdir(join(dir, sub));
          for (const f of files) {
            try {
              const fs = await stat(join(dir, sub, f));
              if (fs.mtimeMs > max) max = fs.mtimeMs;
            } catch {
              // ignore
            }
          }
        } catch {
          // ignore
        }
      } else {
        if (s.mtimeMs > max) max = s.mtimeMs;
      }
    } catch {
      // ignore missing
    }
  }
  return max;
}

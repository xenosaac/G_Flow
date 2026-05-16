import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentBackend } from "../adapters/backend.ts";
import {
  flowDir,
  gflowRoot,
  readState,
  writeState,
} from "./state.ts";
import { readContractYaml, writeContractYaml } from "./contract-io.ts";
import { nextAction, type Action } from "./orchestrator.ts";
import { runWorker, writeHandoff } from "./worker.ts";
import {
  runScrewdriver,
  writeScrewdriverReport,
} from "./validators/screwdriver.ts";
import { runUserTest, writeUserTestReport } from "./validators/user-test.ts";
import {
  runStewardEncode,
  runStewardTriage,
  writeDecision,
  writeTriage,
} from "./steward.ts";
import { Handoff, type HandoffT } from "../artifacts/handoff.ts";
import {
  ValidatorReport,
  type ValidatorReportT,
  type TriageClassificationT,
} from "../artifacts/reports.ts";
import {
  Contract,
  type AssertionT,
  type ContractT,
} from "../artifacts/contract.ts";
import type { FlowStateT } from "../artifacts/state.ts";

export interface RunFlowOptions {
  flow_id: string;
  target_dir: string;
  target_url: string;
  backend: AgentBackend;
  /** Test hooks: replace component runners. */
  workerRun?: typeof runWorker;
  screwdriverRun?: typeof runScrewdriver;
  userTestRun?: typeof runUserTest;
  stewardEncodeRun?: typeof runStewardEncode;
  stewardTriageRun?: typeof runStewardTriage;
  /** Cap orchestrator iterations (test safety net). */
  maxIterations?: number;
  /** Override GFLOW_ROOT for tests. */
  root?: string;
  /** Flip phase=planning → executing on entry (user has approved). */
  approve?: boolean;
}

export interface RunFlowResult {
  status: "complete" | "needs_human" | "awaiting_approval";
  reason?: string;
  iterations: number;
}

/**
 * Orchestrator loop. Reads state.json each iteration, asks nextAction what to
 * do, dispatches a single step, writes the artifact + new state, repeats.
 *
 * Terminates on action.type === "complete" or "halt".
 */
export async function runFlow(opts: RunFlowOptions): Promise<RunFlowResult> {
  const root = opts.root ?? gflowRoot();
  const dir = flowDir(opts.flow_id, root);
  const contractPath = join(dir, "contract.yaml");
  const handoffsDir = join(dir, "handoffs");
  const reportsDir = join(dir, "reports");
  const decisionsDir = join(dir, "decisions");

  let state = await readState(opts.flow_id, root);

  // Phase 1 → Phase 2 gate. In V1 this is the "user reviewed contract" moment.
  if (state.phase === "planning") {
    if (!opts.approve) {
      return {
        status: "awaiting_approval",
        reason: "contract awaits review; pass approve:true",
        iterations: 0,
      };
    }
    state = {
      ...state,
      phase: "executing",
      updated_at: new Date().toISOString(),
    };
    await writeState(state, root);
  }

  const maxIter = opts.maxIterations ?? 200;
  for (let iter = 0; iter < maxIter; iter++) {
    state = await readState(opts.flow_id, root);
    if (state.phase === "complete")
      return { status: "complete", iterations: iter };
    if (state.phase === "needs_human")
      return { status: "needs_human", iterations: iter };

    const contract = await readContractYaml(contractPath);
    const lastScrewdriver = state.current_feature
      ? await readLatestValidatorReport(
          reportsDir,
          state.current_feature,
          "screwdriver",
        )
      : null;
    const lastUserTest = state.current_feature
      ? await readLatestValidatorReport(
          reportsDir,
          state.current_feature,
          "usertest",
        )
      : null;
    const lastTriage = state.current_feature
      ? await readLatestTriage(reportsDir, state.current_feature)
      : null;

    const action = nextAction({
      state,
      contract,
      lastScrewdriver,
      lastUserTest,
      lastTriage,
    });

    await dispatch(action, opts, state, contract, {
      dir,
      handoffsDir,
      reportsDir,
      decisionsDir,
      contractPath,
      root,
    });

    if (action.type === "complete")
      return { status: "complete", iterations: iter + 1 };
    if (action.type === "halt") {
      if (action.reason === "needs_human") {
        return {
          status: "needs_human",
          reason: action.detail,
          iterations: iter + 1,
        };
      }
      return {
        status: action.reason,
        reason: action.detail,
        iterations: iter + 1,
      };
    }
  }
  throw new Error(`runFlow: exceeded max iterations (${maxIter})`);
}

interface DispatchCtx {
  dir: string;
  handoffsDir: string;
  reportsDir: string;
  decisionsDir: string;
  contractPath: string;
  root: string;
}

async function dispatch(
  action: Action,
  opts: RunFlowOptions,
  state: FlowStateT,
  contract: ContractT,
  ctx: DispatchCtx,
): Promise<void> {
  switch (action.type) {
    case "complete": {
      await writeState(
        {
          ...state,
          phase: "complete",
          current_step: null,
          updated_at: new Date().toISOString(),
        },
        ctx.root,
      );
      return;
    }
    case "halt": {
      const phase =
        action.reason === "needs_human" ? "needs_human" : state.phase;
      await writeState(
        { ...state, phase, updated_at: new Date().toISOString() },
        ctx.root,
      );
      return;
    }
    case "advance": {
      await writeState(
        {
          ...state,
          current_milestone: action.to.milestone_id,
          current_feature: action.to.feature_id,
          current_step: null,
          updated_at: new Date().toISOString(),
        },
        ctx.root,
      );
      return;
    }
    case "worker": {
      let s = state;
      if (s.current_feature !== action.feature.id) {
        s = {
          ...s,
          current_milestone: action.milestone_id,
          current_feature: action.feature.id,
          current_step: null,
          updated_at: new Date().toISOString(),
        };
        await writeState(s, ctx.root);
      }
      const { handoff } = await (opts.workerRun ?? runWorker)({
        flow_id: opts.flow_id,
        feature: action.feature,
        milestone_id: action.milestone_id,
        target_dir: opts.target_dir,
        backend: opts.backend,
        attempt: action.attempt,
      });
      await writeHandoff(handoff, ctx.handoffsDir, action.attempt);
      await writeState(
        {
          ...s,
          current_step: "worker",
          updated_at: new Date().toISOString(),
        },
        ctx.root,
      );
      return;
    }
    case "corrective_worker": {
      const { handoff } = await (opts.workerRun ?? runWorker)({
        flow_id: opts.flow_id,
        feature: action.feature,
        milestone_id: action.milestone_id,
        target_dir: opts.target_dir,
        backend: opts.backend,
        attempt: action.attempt,
        failures: action.failures,
      });
      await writeHandoff(handoff, ctx.handoffsDir, action.attempt);
      const newCorrective =
        (state.corrective_attempts[action.feature.id] ?? 0) + 1;
      await writeState(
        {
          ...state,
          current_step: "worker",
          corrective_attempts: {
            ...state.corrective_attempts,
            [action.feature.id]: newCorrective,
          },
          updated_at: new Date().toISOString(),
        },
        ctx.root,
      );
      return;
    }
    case "screwdriver": {
      const report = await (opts.screwdriverRun ?? runScrewdriver)({
        flow_id: opts.flow_id,
        feature: action.feature,
        target_dir: opts.target_dir,
      });
      const attempt = featureAttempt(state, action.feature.id);
      await writeScrewdriverReport(report, ctx.reportsDir, attempt);
      await writeState(
        {
          ...state,
          current_step: "screwdriver",
          updated_at: new Date().toISOString(),
        },
        ctx.root,
      );
      return;
    }
    case "usertest": {
      const report = await (opts.userTestRun ?? runUserTest)({
        flow_id: opts.flow_id,
        feature: action.feature,
        target_dir: opts.target_dir,
        target_url: opts.target_url,
      });
      const attempt = featureAttempt(state, action.feature.id);
      await writeUserTestReport(report, ctx.reportsDir, attempt);
      await writeState(
        {
          ...state,
          current_step: "usertest",
          updated_at: new Date().toISOString(),
        },
        ctx.root,
      );
      return;
    }
    case "steward_encode": {
      const lastH = await readLatestHandoff(
        ctx.handoffsDir,
        action.feature.id,
      );
      const lastS = await readLatestValidatorReport(
        ctx.reportsDir,
        action.feature.id,
        "screwdriver",
      );
      const lastU = await readLatestValidatorReport(
        ctx.reportsDir,
        action.feature.id,
        "usertest",
      );
      const r = await (opts.stewardEncodeRun ?? runStewardEncode)({
        flow_id: opts.flow_id,
        feature: action.feature,
        attempt: action.attempt,
        outcome: action.outcome,
        handoff: lastH,
        screwdriver: lastS,
        usertest: lastU,
        cwd: ctx.dir,
        backend: opts.backend,
      });
      await writeDecision(
        r.body,
        action.feature.id,
        action.attempt,
        ctx.decisionsDir,
      );
      await writeState(
        {
          ...state,
          current_step: "steward_encode",
          updated_at: new Date().toISOString(),
        },
        ctx.root,
      );
      return;
    }
    case "steward_triage": {
      const lastH = await readLatestHandoff(
        ctx.handoffsDir,
        action.feature.id,
      );
      const lastS = await readLatestValidatorReport(
        ctx.reportsDir,
        action.feature.id,
        "screwdriver",
      );
      const lastU = await readLatestValidatorReport(
        ctx.reportsDir,
        action.feature.id,
        "usertest",
      );
      const triage = await (opts.stewardTriageRun ?? runStewardTriage)({
        flow_id: opts.flow_id,
        feature: action.feature,
        failures: action.failures,
        handoff: lastH,
        screwdriver: lastS,
        usertest: lastU,
        corrective_attempts:
          state.corrective_attempts[action.feature.id] ?? 0,
        cwd: ctx.dir,
        backend: opts.backend,
        forcedHint: action.hint,
      });
      const attempt = featureAttempt(state, action.feature.id);
      await writeTriage(triage, action.feature.id, attempt, ctx.reportsDir);
      if (
        triage.classification === "MISSING_ASSERTION" &&
        triage.new_assertions.length > 0
      ) {
        const updated = appendAssertions(
          contract,
          action.feature.id,
          triage.new_assertions,
        );
        await writeContractYaml(updated, ctx.contractPath);
      }
      await writeState(
        {
          ...state,
          current_step: "steward_triage",
          updated_at: new Date().toISOString(),
        },
        ctx.root,
      );
      return;
    }
  }
}

function featureAttempt(state: FlowStateT, feature_id: string): number {
  return (state.corrective_attempts[feature_id] ?? 0) + 1;
}

export function appendAssertions(
  contract: ContractT,
  feature_id: string,
  newOnes: AssertionT[],
): ContractT {
  const updated: ContractT = JSON.parse(JSON.stringify(contract));
  for (const m of updated.milestones) {
    for (const f of m.features) {
      if (f.id === feature_id) {
        for (const a of newOnes) {
          f.assertions.push({
            ...a,
            origin: a.origin === "corrective" ? "corrective" : "corrective",
            status: a.status ?? "pending",
            attempts: a.attempts ?? [],
          });
        }
      }
    }
  }
  return Contract.parse(updated);
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

async function readLatestValidatorReport(
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
): Promise<{ classification: TriageClassificationT } | null> {
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
    if (!parsed || !parsed.classification) return null;
    return { classification: parsed.classification };
  } catch {
    return null;
  }
}

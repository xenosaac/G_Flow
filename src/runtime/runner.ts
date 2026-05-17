import { readdir, readFile, rename, stat } from "node:fs/promises";
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
import { flushGbrain } from "../gbrain/client.ts";
import {
  emitFeatureClose,
  emitFlowComplete,
  emitMilestoneClose,
  emitStewardDecision,
  emitStewardTriage,
  emitValidatorReport,
  emitWorkerHandoff,
} from "../gbrain/emit.ts";
import { selectAdapter } from "../gbrain/adapter.ts";
import {
  acquireRunLock,
  clearPause,
  heartbeatRunLock,
  readControl,
  releaseRunLock,
} from "./control.ts";
import {
  mergePassingWorktree,
  prepareFeatureWorktree,
  worktreeForAttempt,
} from "./worktree.ts";

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
  /** Test hook: disable run.lock ownership. */
  useRunLock?: boolean;
  /** Test hook: lock freshness threshold. */
  lockStaleMs?: number;
}

export interface RunFlowResult {
  status: "complete" | "needs_human" | "awaiting_approval" | "paused";
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

  let lockAcquired = false;
  if (opts.useRunLock !== false) {
    await acquireRunLock(opts.flow_id, root, opts.lockStaleMs);
    lockAcquired = true;
  }

  try {
    let state = await readState(opts.flow_id, root);

    if (state.phase === "clarifying") {
      return {
        status: "awaiting_approval",
        reason: "flow is waiting for clarification answers",
        iterations: 0,
      };
    }

    if (state.phase === "paused") {
      if (!opts.approve) {
        return {
          status: "paused",
          reason: "flow is paused; pass approve:true to resume",
          iterations: 0,
        };
      }
      await clearPause(opts.flow_id, root);
      state = {
        ...state,
        phase: "executing",
        updated_at: new Date().toISOString(),
      };
      await writeState(state, root);
    }

    // Phase 1 -> Phase 2 gate. This is the "user reviewed contract" moment.
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
      if (state.phase === "paused")
        return { status: "paused", iterations: iter };
      if (state.phase === "needs_human")
        return { status: "needs_human", iterations: iter };

      const control = await readControl(opts.flow_id, root);
      if (control.pause_requested) {
        await writeState(
          {
            ...state,
            phase: "paused",
            updated_at: new Date().toISOString(),
          },
          root,
        );
        return {
          status: "paused",
          reason: control.reason ?? "pause requested",
          iterations: iter,
        };
      }

      if (lockAcquired) await heartbeatRunLock(opts.flow_id, "deciding", root);
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

      if (lockAcquired) await heartbeatRunLock(opts.flow_id, action.type, root);
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
  } finally {
    // MUST flush before the caller exits — promise chains aren't durability.
    // Every return path (complete/halt/needs_human/paused/awaiting_approval/exception)
    // passes through here, so the JSONL outbox is always durable on disk.
    await flushGbrain(opts.flow_id);
    if (lockAcquired) await releaseRunLock(opts.flow_id, root);
  }
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
      const now = new Date().toISOString();
      // Async, fire-and-forget. The runtime never waits for GBrain.
      if (state.current_feature && state.current_milestone) {
        const featureTitle = findFeatureTitle(contract, state.current_feature);
        emitFeatureClose({
          flow_id: opts.flow_id,
          contract,
          feature_id: state.current_feature,
          milestone_id: state.current_milestone,
          feature_title: featureTitle,
          target_dir: opts.target_dir,
          target_url: opts.target_url,
        });
        emitMilestoneClose({
          flow_id: opts.flow_id,
          contract,
          milestone_id: state.current_milestone,
          target_dir: opts.target_dir,
          target_url: opts.target_url,
        });
      }
      emitFlowComplete({
        flow_id: opts.flow_id,
        contract,
        goal: contract.goal,
        target_dir: opts.target_dir,
        target_url: opts.target_url,
      });
      await writeState(
        {
          ...state,
          phase: "complete",
          current_step: null,
          updated_at: now,
        },
        ctx.root,
      );
      // Auto-drain on flow_complete (best-effort, never blocks).
      void selectAdapter().drainOutbox(opts.flow_id).catch(() => {
        // swallow — Console + CLI surface drain failures explicitly
      });
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
      const now = new Date().toISOString();
      emitFeatureClose({
        flow_id: opts.flow_id,
        contract,
        feature_id: action.from.feature_id,
        milestone_id: action.from.milestone_id,
        feature_title: findFeatureTitle(contract, action.from.feature_id),
        target_dir: opts.target_dir,
        target_url: opts.target_url,
      });
      if (action.to.milestone_id !== action.from.milestone_id) {
        emitMilestoneClose({
          flow_id: opts.flow_id,
          contract,
          milestone_id: action.from.milestone_id,
          target_dir: opts.target_dir,
          target_url: opts.target_url,
        });
      }
      await writeState(
        {
          ...state,
          current_milestone: action.to.milestone_id,
          current_feature: action.to.feature_id,
          current_step: null,
          updated_at: now,
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
        ...(await workerTarget(opts, ctx, action.feature.id, action.attempt)),
        flow_id: opts.flow_id,
        feature: action.feature,
        milestone_id: action.milestone_id,
        backend: opts.backend,
        attempt: action.attempt,
      });
      await writeHandoff(handoff, ctx.handoffsDir, action.attempt);
      emitWorkerHandoff({
        flow_id: opts.flow_id,
        contract,
        feature_id: action.feature.id,
        milestone_id: action.milestone_id,
        feature_title: action.feature.title,
        handoff,
        target_dir: opts.target_dir,
      });
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
        ...(await workerTarget(opts, ctx, action.feature.id, action.attempt)),
        flow_id: opts.flow_id,
        feature: action.feature,
        milestone_id: action.milestone_id,
        backend: opts.backend,
        attempt: action.attempt,
        failures: action.failures,
      });
      await writeHandoff(handoff, ctx.handoffsDir, action.attempt);
      emitWorkerHandoff({
        flow_id: opts.flow_id,
        contract,
        feature_id: action.feature.id,
        milestone_id: action.milestone_id,
        feature_title: action.feature.title,
        handoff,
        target_dir: opts.target_dir,
      });
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
      const attempt = featureAttempt(state, action.feature.id);
      const target = await validatorTarget(opts, ctx, action.feature.id, attempt);
      const report = await runWithHiddenWorktreeGitFile(target, () =>
        (opts.screwdriverRun ?? runScrewdriver)({
          flow_id: opts.flow_id,
          feature: action.feature,
          target_dir: target,
        }),
      );
      await writeScrewdriverReport(report, ctx.reportsDir, attempt);
      emitValidatorReport({
        flow_id: opts.flow_id,
        contract,
        feature_id: action.feature.id,
        milestone_id: findMilestoneFor(contract, action.feature.id),
        feature_title: action.feature.title,
        report,
      });
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
      const attempt = featureAttempt(state, action.feature.id);
      const target = await validatorTarget(opts, ctx, action.feature.id, attempt);
      const report = await runWithHiddenWorktreeGitFile(target, () =>
        (opts.userTestRun ?? runUserTest)({
          flow_id: opts.flow_id,
          feature: action.feature,
          target_dir: target,
          target_url: opts.target_url,
        }),
      );
      await writeUserTestReport(report, ctx.reportsDir, attempt);
      emitValidatorReport({
        flow_id: opts.flow_id,
        contract,
        feature_id: action.feature.id,
        milestone_id: findMilestoneFor(contract, action.feature.id),
        feature_title: action.feature.title,
        report,
      });
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
      emitStewardDecision({
        flow_id: opts.flow_id,
        contract,
        feature_id: action.feature.id,
        milestone_id: findMilestoneFor(contract, action.feature.id),
        outcome: action.outcome,
        attempt: action.attempt,
        body_md: r.body,
      });
      if (action.outcome === "passing") {
        await mergePassingWorktree({
          flowDir: ctx.dir,
          targetDir: opts.target_dir,
          flowId: opts.flow_id,
          featureId: action.feature.id,
          attempt: action.attempt,
        });
      }
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
      emitStewardTriage({
        flow_id: opts.flow_id,
        contract,
        feature_id: action.feature.id,
        milestone_id: findMilestoneFor(contract, action.feature.id),
        classification: triage.classification,
        rationale: triage.rationale,
        new_assertions_count: triage.new_assertions.length,
      });
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

async function workerTarget(
  opts: RunFlowOptions,
  ctx: DispatchCtx,
  featureId: string,
  attempt: number,
): Promise<{ target_dir: string }> {
  const ref = await prepareFeatureWorktree({
    flowDir: ctx.dir,
    targetDir: opts.target_dir,
    flowId: opts.flow_id,
    featureId,
    attempt,
  });
  return { target_dir: ref.path };
}

async function validatorTarget(
  opts: RunFlowOptions,
  ctx: DispatchCtx,
  featureId: string,
  attempt: number,
): Promise<string> {
  const ref = await worktreeForAttempt({
    flowDir: ctx.dir,
    targetDir: opts.target_dir,
    flowId: opts.flow_id,
    featureId,
    attempt,
  });
  return ref.path;
}

function findFeatureTitle(
  contract: ContractT,
  featureId: string,
): string | undefined {
  for (const milestone of contract.milestones) {
    const feature = milestone.features.find((f) => f.id === featureId);
    if (feature) return feature.title;
  }
  return undefined;
}

function findMilestoneFor(contract: ContractT, featureId: string): string {
  for (const milestone of contract.milestones) {
    if (milestone.features.some((feature) => feature.id === featureId)) {
      return milestone.id;
    }
  }
  return "";
}

async function runWithHiddenWorktreeGitFile<T>(
  targetDir: string,
  fn: () => Promise<T>,
): Promise<T> {
  const gitFile = join(targetDir, ".git");
  const hidden = `${targetDir}.git.gflow-hidden`;
  let moved = false;
  try {
    const s = await stat(gitFile);
    if (s.isFile()) {
      await rename(gitFile, hidden);
      moved = true;
    }
  } catch {
    // Regular repos have .git as a directory, and non-git targets have none.
  }
  try {
    return await fn();
  } finally {
    if (moved) {
      await rename(hidden, gitFile).catch(() => undefined);
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

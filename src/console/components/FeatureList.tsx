"use client";

import type { FlowSnapshot } from "../lib/snapshot.ts";
import type { MilestoneT, FeatureT } from "../../artifacts/contract.ts";

export default function FeatureList({ snapshot }: { snapshot: FlowSnapshot | null }) {
  if (!snapshot) {
    return (
      <section className="panel plan-panel">
        <h2>Plan</h2>
        <div className="empty">No plan yet. Type a goal in the chat to start.</div>
      </section>
    );
  }
  if (!snapshot.contract) {
    return (
      <section className="panel plan-panel">
        <h2>Plan</h2>
        <div className="empty">Awaiting plan from the Planner…</div>
      </section>
    );
  }
  const isPlanning = snapshot.state.phase === "planning";
  const isExecuting = snapshot.state.phase === "executing";
  const totals = contractTotals(snapshot.contract.milestones);
  return (
    <section className="panel plan-panel">
      <div className="panel-heading">
        <div>
          <h2>Plan</h2>
          <div className="panel-subtitle">
            {totals.milestones} milestones · {totals.features} features · {totals.assertions} assertions
          </div>
        </div>
        {isPlanning ? <span className="draft-pill">Draft</span> : null}
        {isExecuting ? <span className="live-pill">Running</span> : null}
      </div>
      <ul className="milestone-list">
        {snapshot.contract.milestones.map((m) => (
          <MilestoneItem key={m.id} milestone={m} snapshot={snapshot} animate={isExecuting} />
        ))}
      </ul>
    </section>
  );
}

function MilestoneItem({
  milestone,
  snapshot,
  animate,
}: {
  milestone: MilestoneT;
  snapshot: FlowSnapshot;
  animate: boolean;
}) {
  const isCurrentM = snapshot.state.current_milestone === milestone.id;
  return (
    <li className="milestone">
      <div
        className={`milestone-header ${isCurrentM ? "current" : ""} ${
          isCurrentM && animate ? "animate" : ""
        }`}
      >
        <span className="icon">{isCurrentM ? "▾" : "▸"}</span>
        <code>{milestone.id}</code>
        <span>{milestone.title}</span>
      </div>
      <ul className="feature-list">
        {milestone.features.map((f) => (
          <FeatureItem key={f.id} feature={f} snapshot={snapshot} animate={animate} />
        ))}
      </ul>
    </li>
  );
}

function FeatureItem({
  feature,
  snapshot,
  animate,
}: {
  feature: FeatureT;
  snapshot: FlowSnapshot;
  animate: boolean;
}) {
  const isCurrent = snapshot.state.current_feature === feature.id;
  const attempts = snapshot.attempt_history[feature.id]?.attempts ?? 0;
  const failures = snapshot.attempt_history[feature.id]?.latest_failures ?? [];
  const status = featureStatusIcon(feature, isCurrent, attempts, failures);
  const classes = ["feature"];
  if (isCurrent) classes.push("current");
  if (isCurrent && animate) classes.push("animate");
  return (
    <li className={classes.join(" ")}>
      <span className="icon">{status}</span>
      <code className="id">{feature.id}</code>
      <span className="feature-title">{feature.title}</span>
      <span className="feature-meta">
        {feature.assertions.length} assertion{feature.assertions.length === 1 ? "" : "s"}
        {attempts > 0 ? ` · ${attempts} attempt${attempts === 1 ? "" : "s"}` : ""}
      </span>
    </li>
  );
}

function featureStatusIcon(
  _feature: FeatureT,
  isCurrent: boolean,
  attempts: number,
  failures: string[],
): string {
  if (failures.length > 0 && !isCurrent) return "✗";
  if (isCurrent) return "▶";
  if (attempts > 0 && failures.length === 0) return "✓";
  return "○";
}

function contractTotals(milestones: MilestoneT[]) {
  let features = 0;
  let assertions = 0;
  for (const milestone of milestones) {
    features += milestone.features.length;
    assertions += milestone.features.reduce((total, feature) => total + feature.assertions.length, 0);
  }
  return { milestones: milestones.length, features, assertions };
}

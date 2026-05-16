"use client";

import type { FlowSnapshot } from "../lib/snapshot.ts";
import type { MilestoneT, FeatureT } from "../../artifacts/contract.ts";

export default function FeatureList({ snapshot }: { snapshot: FlowSnapshot | null }) {
  if (!snapshot) {
    return (
      <section className="panel">
        <h2>Executor</h2>
        <div className="empty">No plan yet. Type a goal in the chat to start.</div>
      </section>
    );
  }
  if (!snapshot.contract) {
    return (
      <section className="panel">
        <h2>Executor</h2>
        <div className="empty">Awaiting plan from the Planner…</div>
      </section>
    );
  }
  const isPlanning = snapshot.state.phase === "planning";
  const isExecuting = snapshot.state.phase === "executing";
  return (
    <section className="panel">
      <h2>
        Executor
        {isPlanning ? <span className="draft-pill">DRAFT</span> : null}
        {isExecuting ? <span className="live-pill">RUNNING</span> : null}
      </h2>
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
        <span className="icon">{isCurrentM ? "▼" : "▷"}</span>
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
      <span>{feature.title}</span>
      <span style={{ marginLeft: "auto", color: "var(--text-dim)", fontSize: 11 }}>
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

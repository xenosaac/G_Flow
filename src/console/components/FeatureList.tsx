"use client";

import type { FlowSnapshot } from "../lib/snapshot.ts";
import type { MilestoneT, FeatureT } from "../../artifacts/contract.ts";

export default function FeatureList({ snapshot }: { snapshot: FlowSnapshot }) {
  if (!snapshot.contract) {
    return (
      <section className="panel">
        <h2>Milestones &amp; Features</h2>
        <div className="empty">contract.yaml not yet written.</div>
      </section>
    );
  }
  return (
    <section className="panel">
      <h2>Milestones &amp; Features</h2>
      <ul className="milestone-list">
        {snapshot.contract.milestones.map((m) => (
          <MilestoneItem key={m.id} milestone={m} snapshot={snapshot} />
        ))}
      </ul>
    </section>
  );
}

function MilestoneItem({
  milestone,
  snapshot,
}: {
  milestone: MilestoneT;
  snapshot: FlowSnapshot;
}) {
  const isCurrentM = snapshot.state.current_milestone === milestone.id;
  return (
    <li className="milestone">
      <div className="milestone-header">
        <span className="icon">{isCurrentM ? "▼" : "▷"}</span>
        <code>{milestone.id}</code>
        <span>{milestone.title}</span>
      </div>
      <ul className="feature-list">
        {milestone.features.map((f) => (
          <FeatureItem key={f.id} feature={f} snapshot={snapshot} />
        ))}
      </ul>
    </li>
  );
}

function FeatureItem({
  feature,
  snapshot,
}: {
  feature: FeatureT;
  snapshot: FlowSnapshot;
}) {
  const isCurrent = snapshot.state.current_feature === feature.id;
  const attempts = snapshot.attempt_history[feature.id]?.attempts ?? 0;
  const failures = snapshot.attempt_history[feature.id]?.latest_failures ?? [];
  const status = featureStatusIcon(feature, isCurrent, attempts, failures);
  return (
    <li className={`feature ${isCurrent ? "current" : ""}`}>
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

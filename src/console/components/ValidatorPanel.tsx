"use client";

import type { FlowSnapshot } from "../lib/snapshot.ts";
import type { ValidatorReportT } from "../../artifacts/reports.ts";
import type { FlowStepT } from "../../artifacts/state.ts";

const STEP_TO_BLOCK: Record<FlowStepT, "screwdriver" | "usertest" | "triage" | null> = {
  worker: null,
  screwdriver: "screwdriver",
  usertest: "usertest",
  steward_encode: null,
  steward_triage: "triage",
};

export default function ValidatorPanel({ snapshot }: { snapshot: FlowSnapshot | null }) {
  if (!snapshot) {
    return (
      <section className="panel">
        <h2>Validator</h2>
        <div className="empty">No validator activity yet.</div>
      </section>
    );
  }
  const { screwdriver, usertest, triage } = snapshot.latest;
  if (!screwdriver && !usertest && !triage) {
    return (
      <section className="panel">
        <h2>Validator</h2>
        <div className="empty">No validator reports yet for the current feature.</div>
      </section>
    );
  }

  const step = snapshot.state.current_step;
  const animate = snapshot.state.phase === "executing";
  const activeBlock = step ? STEP_TO_BLOCK[step] : null;

  return (
    <section className="panel">
      <h2>Validator</h2>
      {screwdriver ? (
        <ValidatorBlock
          report={screwdriver}
          label="Screwdriver"
          current={activeBlock === "screwdriver"}
          animate={animate}
        />
      ) : null}
      {usertest ? (
        <ValidatorBlock
          report={usertest}
          label="User Testing"
          current={activeBlock === "usertest"}
          animate={animate}
        />
      ) : null}
      {triage ? (
        <div
          className={[
            "validator-block",
            triage.classification === "MISSING_ASSERTION" ? "pass" : "fail",
            activeBlock === "triage" ? "current" : "",
            activeBlock === "triage" && animate ? "animate" : "",
          ]
            .filter(Boolean)
            .join(" ")}
        >
          <div className="v-header">
            <span>Steward triage</span>
            <span>{triage.classification}</span>
          </div>
          <div style={{ fontSize: 12, color: "var(--text-dim)" }}>{triage.rationale}</div>
        </div>
      ) : null}
    </section>
  );
}

function ValidatorBlock({
  report,
  label,
  current,
  animate,
}: {
  report: ValidatorReportT;
  label: string;
  current: boolean;
  animate: boolean;
}) {
  const classes = ["validator-block", report.status];
  if (current) classes.push("current");
  if (current && animate) classes.push("animate");
  return (
    <div className={classes.join(" ")}>
      <div className="v-header">
        <span>
          {label}{" "}
          <span style={{ color: "var(--text-dim)", fontWeight: 400 }}>
            ({report.validator})
          </span>
        </span>
        <span
          style={{
            color:
              report.status === "pass"
                ? "var(--pass)"
                : report.status === "fail"
                  ? "var(--fail)"
                  : "var(--warn)",
          }}
        >
          {report.status.toUpperCase()}
          {report.steward_hint !== "NONE" ? ` · hint=${report.steward_hint}` : ""}
        </span>
      </div>
      <ul style={{ listStyle: "none" }}>
        {report.assertion_results.map((r) => (
          <li key={r.assertion_id} className="assertion-line">
            <span className={`outcome ${r.outcome}`}>{r.outcome}</span>
            <code>{r.assertion_id}</code>
            <span>{r.detail}</span>
          </li>
        ))}
      </ul>
      {report.status === "tool_error" ? (
        <pre
          style={{
            marginTop: 8,
            padding: 8,
            background: "var(--bg)",
            borderRadius: 4,
            fontSize: 11,
            overflowX: "auto",
            color: "var(--warn)",
          }}
        >
          {report.raw_stderr_tail.slice(0, 800)}
        </pre>
      ) : null}
    </div>
  );
}

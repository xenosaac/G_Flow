"use client";

import type { FlowSnapshot } from "../lib/snapshot.ts";
import type { ValidatorReportT } from "../../artifacts/reports.ts";

export default function ValidatorPanel({ snapshot }: { snapshot: FlowSnapshot }) {
  const { screwdriver, usertest, triage } = snapshot.latest;
  if (!screwdriver && !usertest && !triage) {
    return (
      <section className="panel">
        <h2>Validators</h2>
        <div className="empty">No validator reports yet for the current feature.</div>
      </section>
    );
  }
  return (
    <section className="panel">
      <h2>Validators (latest for current feature)</h2>
      {screwdriver ? <ValidatorBlock report={screwdriver} label="Screwdriver" /> : null}
      {usertest ? <ValidatorBlock report={usertest} label="User Testing" /> : null}
      {triage ? (
        <div
          className={`validator-block ${
            triage.classification === "INFRA"
              ? "fail"
              : triage.classification === "BROKEN_IMPL"
                ? "fail"
                : "pass"
          }`}
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
}: {
  report: ValidatorReportT;
  label: string;
}) {
  return (
    <div className={`validator-block ${report.status}`}>
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

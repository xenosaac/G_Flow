"use client";

import type { FlowSnapshot } from "../lib/snapshot.ts";

export default function NeedsHumanBanner({ snapshot }: { snapshot: FlowSnapshot }) {
  if (snapshot.state.phase !== "needs_human") return null;
  return (
    <div className="banner-needs-human" role="alert" data-testid="needs-human-banner">
      <h2>needs_human — orchestrator halted</h2>
      <div>
        Flow <code>{snapshot.flow_id}</code> stopped.
        {snapshot.state.current_feature ? (
          <>
            {" "}
            Current feature: <code>{snapshot.state.current_feature}</code>.
          </>
        ) : null}
      </div>
      {snapshot.needs_human_reason ? (
        <div className="detail" style={{ marginTop: 8 }}>
          {snapshot.needs_human_reason}
        </div>
      ) : null}
    </div>
  );
}

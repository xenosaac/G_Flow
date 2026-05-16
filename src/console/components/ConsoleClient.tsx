"use client";

import { useEffect, useState } from "react";
import type { FlowSnapshot } from "../lib/snapshot.ts";
import NeedsHumanBanner from "./NeedsHumanBanner";
import FlowStatus from "./FlowStatus";
import FeatureList from "./FeatureList";
import ValidatorPanel from "./ValidatorPanel";
import AgentWorkbench from "./AgentWorkbench";

type ConnState = "connecting" | "live" | "idle" | "error";

export default function ConsoleClient({
  initial,
}: {
  initial: FlowSnapshot | null;
}) {
  const [snapshot, setSnapshot] = useState<FlowSnapshot | null>(initial);
  const [conn, setConn] = useState<ConnState>("connecting");

  useEffect(() => {
    const source = new EventSource("/api/stream");
    source.onopen = () => setConn("live");
    source.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === "snapshot") {
          setSnapshot(msg.data as FlowSnapshot);
          setConn("live");
        } else if (msg.type === "no_flow") {
          setSnapshot(null);
          setConn("idle");
        } else if (msg.type === "error") {
          setConn("error");
        }
      } catch {
        setConn("error");
      }
    };
    source.onerror = () => setConn("error");
    return () => source.close();
  }, []);

  return (
    <main className="container">
      <header className="header">
        <h1>G_FLOW CONSOLE</h1>
        <div className="meta">
          local-first orchestration for any coding agent · SSE @ /api/stream
        </div>
      </header>

      <AgentWorkbench snapshot={snapshot} />

      {snapshot ? (
        <>
          <NeedsHumanBanner snapshot={snapshot} />
          <FlowStatus snapshot={snapshot} />
          <FeatureList snapshot={snapshot} />
          <ValidatorPanel snapshot={snapshot} />
        </>
      ) : (
        <section className="panel">
          <h2>No flow yet</h2>
          <div className="empty">
            Type <code>/start &lt;goal&gt;</code> in the Workbench above, or run <code>gflow start &quot;&lt;goal&gt;&quot;</code> in this directory.
          </div>
        </section>
      )}

      <div className={`connection-indicator ${conn}`} data-testid="conn-indicator">
        {conn === "live" ? "● live" : conn === "connecting" ? "○ connecting" : conn === "idle" ? "○ idle" : "● error"}
      </div>
    </main>
  );
}

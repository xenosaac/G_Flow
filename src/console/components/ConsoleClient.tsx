"use client";

import { useEffect, useState } from "react";
import type { FlowSnapshot } from "../lib/snapshot.ts";
import NeedsHumanBanner from "./NeedsHumanBanner";
import FeatureList from "./FeatureList";
import ValidatorPanel from "./ValidatorPanel";
import AgentWorkbench from "./AgentWorkbench";
import GBrainDashboard from "./GBrainDashboard";

const HIDDEN_FLOW_STORAGE_KEY = "gflow:hidden-flow-id";

export default function ConsoleClient({
  initial,
}: {
  initial: FlowSnapshot | null;
}) {
  const [snapshot, setSnapshot] = useState<FlowSnapshot | null>(initial);
  const [hiddenFlowId, setHiddenFlowId] = useState<string | null>(null);

  useEffect(() => {
    const stored = readHiddenFlowId();
    if (!stored) return;
    setHiddenFlowId(stored);
    setSnapshot((current) => (current?.flow_id === stored ? null : current));
  }, []);

  useEffect(() => {
    const source = new EventSource("/api/stream");
    source.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === "snapshot") {
          const next = msg.data as FlowSnapshot;
          if (hiddenFlowId && next.flow_id === hiddenFlowId) return;
          if (hiddenFlowId && next.flow_id !== hiddenFlowId) {
            clearHiddenFlowId();
            setHiddenFlowId(null);
          }
          setSnapshot(next);
        } else if (msg.type === "no_flow") {
          setSnapshot(null);
        }
      } catch {
        // Keep the last rendered snapshot if one malformed SSE message arrives.
      }
    };
    return () => source.close();
  }, [hiddenFlowId]);

  function handleNewChat() {
    if (snapshot?.flow_id) {
      writeHiddenFlowId(snapshot.flow_id);
      setHiddenFlowId(snapshot.flow_id);
    } else {
      clearHiddenFlowId();
      setHiddenFlowId(null);
    }
    setSnapshot(null);
  }

  function handleDemoLoaded(next: FlowSnapshot) {
    clearHiddenFlowId();
    setHiddenFlowId(null);
    setSnapshot(next);
  }

  return (
    <main className="container console-shell">
      <header className="header topbar">
        <div className="brand-lockup">
          <div className="eyebrow">local orchestration</div>
          <h1>G_FLOW Console</h1>
        </div>
      </header>

      <div className="layout">
        <aside className="col-left side-stack">
          {snapshot?.state.phase === "needs_human" ? (
            <NeedsHumanBanner snapshot={snapshot} />
          ) : null}
          <ValidatorPanel snapshot={snapshot} />
          <GBrainDashboard snapshot={snapshot} />
        </aside>

        <section className="col-center">
          <AgentWorkbench
            snapshot={snapshot}
            onNewChat={handleNewChat}
            onDemoLoaded={handleDemoLoaded}
          />
        </section>

        <aside className="col-right">
          <FeatureList snapshot={snapshot} />
        </aside>
      </div>
    </main>
  );
}

function readHiddenFlowId(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(HIDDEN_FLOW_STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeHiddenFlowId(flowId: string): void {
  try {
    window.localStorage.setItem(HIDDEN_FLOW_STORAGE_KEY, flowId);
  } catch {
    // localStorage may be unavailable in locked-down browsers.
  }
}

function clearHiddenFlowId(): void {
  try {
    window.localStorage.removeItem(HIDDEN_FLOW_STORAGE_KEY);
  } catch {
    // localStorage may be unavailable in locked-down browsers.
  }
}

"use client";

import { useEffect, useState } from "react";
import type { FlowSnapshot } from "../lib/snapshot.ts";

interface Entry {
  kind: "feature_close" | "milestone_close" | "flow_complete";
  recorded_at: string;
  payload: Record<string, unknown>;
  file: string;
}

interface QueueResponse {
  flow_id: string | null;
  entries: Entry[];
  counts: { feature_close: number; milestone_close: number; flow_complete: number };
}

const KIND_LABEL: Record<Entry["kind"], string> = {
  feature_close: "feature",
  milestone_close: "milestone",
  flow_complete: "flow",
};

const KIND_COLOR: Record<Entry["kind"], string> = {
  feature_close: "var(--accent)",
  milestone_close: "var(--pass)",
  flow_complete: "var(--warn)",
};

export default function GBrainDashboard({ snapshot }: { snapshot: FlowSnapshot | null }) {
  const flowId = snapshot?.flow_id ?? null;
  const isRunning = snapshot?.state.phase === "executing";
  const [data, setData] = useState<QueueResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function fetchOnce() {
      try {
        const url = flowId ? `/api/gbrain?flow_id=${encodeURIComponent(flowId)}` : "/api/gbrain";
        const r = await fetch(url);
        const d = (await r.json()) as QueueResponse;
        if (!cancelled) {
          setData(d);
          setErr(null);
        }
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e));
      }
    }
    void fetchOnce();
    const interval = setInterval(
      () => {
        void fetchOnce();
      },
      isRunning ? 2000 : 8000,
    );
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [flowId, isRunning]);

  if (!data) {
    return (
      <section className="panel">
        <h2>GBrain Dashboard</h2>
        <div className="empty">
          {err ? `error: ${err}` : "loading snapshots…"}
        </div>
        <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 8 }}>
          Local JSONL queue · real GBrain API integration is V2 (TODOS T5).
        </div>
      </section>
    );
  }

  const total = data.entries.length;
  return (
    <section className="panel">
      <h2>
        GBrain Dashboard
        <span
          style={{
            marginLeft: 8,
            fontSize: 11,
            color: "var(--text-dim)",
            fontWeight: 400,
            textTransform: "none",
            letterSpacing: 0,
          }}
        >
          {total} snapshot{total === 1 ? "" : "s"} queued
        </span>
      </h2>
      <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
        {(["feature_close", "milestone_close", "flow_complete"] as const).map((k) => (
          <div
            key={k}
            style={{
              padding: "4px 10px",
              border: `1px solid var(--border)`,
              borderRadius: 999,
              fontSize: 11,
              color: KIND_COLOR[k],
              background: "var(--bg-elev)",
            }}
          >
            <strong style={{ color: "var(--text)" }}>{data.counts[k]}</strong> · {KIND_LABEL[k]}
          </div>
        ))}
      </div>

      {data.entries.length === 0 ? (
        <div className="empty">No snapshots queued for this flow yet.</div>
      ) : (
        <ul style={{ listStyle: "none", display: "flex", flexDirection: "column", gap: 4 }}>
          {data.entries.slice(0, 10).map((e, i) => {
            const time = formatTime(e.recorded_at);
            const subject =
              (e.payload.feature_id as string | undefined) ??
              (e.payload.milestone_id as string | undefined) ??
              "—";
            return (
              <li
                key={i}
                style={{
                  display: "flex",
                  gap: 8,
                  padding: "4px 8px",
                  borderLeft: `2px solid ${KIND_COLOR[e.kind]}`,
                  background: "var(--bg)",
                  borderRadius: 4,
                  fontSize: 12,
                }}
              >
                <code style={{ color: "var(--text-dim)", fontSize: 11 }}>{time}</code>
                <span style={{ color: KIND_COLOR[e.kind], fontWeight: 600 }}>
                  {KIND_LABEL[e.kind]}
                </span>
                <code>{subject}</code>
              </li>
            );
          })}
        </ul>
      )}

      <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 12 }}>
        Reading <code>.gflow/{flowId ?? "&lt;flow&gt;"}/gbrain-queue/*.jsonl</code> · refresh every{" "}
        {isRunning ? "2s" : "8s"} · real GBrain API integration is V2 (TODOS T5).
      </div>
    </section>
  );
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso.slice(11, 19);
    return d.toLocaleTimeString(undefined, { hour12: false });
  } catch {
    return iso.slice(11, 19);
  }
}

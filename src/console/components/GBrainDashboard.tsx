"use client";

import { useEffect, useState } from "react";
import type { FlowSnapshot } from "../lib/snapshot.ts";

type GbrainMode = "off" | "local-cli" | "mcp-http";

interface Entry {
  kind: string;
  recorded_at: string;
  payload: Record<string, unknown>;
  file: string;
  sync_state: "queued" | "synced" | "failed";
}

interface QueueResponse {
  flow_id: string | null;
  mode: GbrainMode;
  source_id: string;
  health: {
    ok: boolean;
    reason: string;
    detail?: string;
    warnings: string[];
    checked_at: string;
  };
  queue: { queued: number; synced: number; failed: number };
  last_drain: { started_at: string; finished_at: string; drained: number; synced: number; failed: number } | null;
  last_error: string | null;
  entries: Entry[];
}

const MODE_COLOR: Record<GbrainMode, string> = {
  off: "var(--text-dim)",
  "local-cli": "var(--accent)",
  "mcp-http": "var(--pass)",
};

const SYNC_COLOR: Record<Entry["sync_state"], string> = {
  queued: "var(--warn)",
  synced: "var(--pass)",
  failed: "var(--fail)",
};

const KIND_LABEL: Record<string, string> = {
  plan_created: "plan",
  feature_close: "feature",
  milestone_close: "milestone",
  flow_complete: "flow",
  worker_handoff: "handoff",
  validator_report: "validator",
  steward_decision: "decision",
  steward_triage: "triage",
};

export default function GBrainDashboard({ snapshot }: { snapshot: FlowSnapshot | null }) {
  const flowId = snapshot?.flow_id ?? null;
  const isRunning = snapshot?.state.phase === "executing";
  const [data, setData] = useState<QueueResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [draining, setDraining] = useState(false);
  const [drainMsg, setDrainMsg] = useState<string | null>(null);

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

  async function handleDrain() {
    if (!data || data.mode === "off") return;
    setDraining(true);
    setDrainMsg(null);
    try {
      const r = await fetch("/api/gbrain/drain", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ flow_id: flowId }),
      });
      const result = await r.json();
      if (result.ok) {
        setDrainMsg(`drained ${result.synced}/${result.drained} (failed=${result.failed})`);
      } else {
        setDrainMsg(`drain failed: ${result.error ?? result.errors?.[0]?.message ?? "unknown"}`);
      }
    } catch (e) {
      setDrainMsg(`drain error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setDraining(false);
    }
  }

  if (!data) {
    return (
      <section className="panel" data-testid="gbrain-dashboard">
        <h2>GBrain Dashboard</h2>
        <div className="empty">{err ? `error: ${err}` : "loading…"}</div>
      </section>
    );
  }

  const mode = (data.mode ?? "off") as GbrainMode;
  const source_id = data.source_id ?? "gflow";
  const health = data.health ?? {
    ok: true,
    reason: "ok",
    detail: undefined,
    warnings: [] as string[],
    checked_at: "",
  };
  const queue = data.queue ?? { queued: 0, synced: 0, failed: 0 };
  const entries = data.entries ?? [];
  const last_drain = data.last_drain ?? null;
  const last_error = data.last_error ?? null;
  const total = queue.queued + queue.synced + queue.failed;
  const drainDisabled = draining || mode === "off";

  return (
    <section className="panel" data-testid="gbrain-dashboard">
      <h2 style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span>GBrain Dashboard</span>
        <span
          data-testid="gbrain-mode-badge"
          style={{
            padding: "2px 8px",
            borderRadius: 4,
            fontSize: 10,
            color: MODE_COLOR[mode],
            border: `1px solid ${MODE_COLOR[mode]}`,
            textTransform: "uppercase",
            letterSpacing: 0.5,
          }}
        >
          {mode}
        </span>
        <span
          data-testid="gbrain-health-pill"
          style={{
            fontSize: 11,
            color: health.ok ? "var(--pass)" : "var(--fail)",
            fontWeight: 400,
            textTransform: "none",
            letterSpacing: 0,
          }}
          title={health.detail ?? ""}
        >
          {health.ok ? "● ok" : `● ${health.reason}`}
        </span>
        <button
          data-testid="gbrain-drain-button"
          onClick={handleDrain}
          disabled={drainDisabled}
          style={{
            marginLeft: "auto",
            fontSize: 11,
            padding: "4px 10px",
            opacity: drainDisabled ? 0.4 : 1,
            cursor: drainDisabled ? "not-allowed" : "pointer",
            background: "var(--bg-elev)",
            border: "1px solid var(--border)",
            borderRadius: 4,
            color: "var(--text)",
          }}
          title={mode === "off" ? "Set GBRAIN_MODE=local-cli or mcp-http to enable" : "Drain queued snapshots into GBrain"}
        >
          {draining ? "draining…" : "Drain now"}
        </button>
      </h2>

      <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
        <StatChip count={queue.queued} label="queued" color={SYNC_COLOR.queued} />
        <StatChip count={queue.synced} label="synced" color={SYNC_COLOR.synced} />
        <StatChip count={queue.failed} label="failed" color={SYNC_COLOR.failed} />
        <span
          style={{
            padding: "4px 10px",
            fontSize: 11,
            color: "var(--text-dim)",
          }}
        >
          last drain: {last_drain ? formatRelativeTime(last_drain.finished_at) : "—"}
        </span>
        {drainMsg ? (
          <span style={{ fontSize: 11, color: "var(--text-dim)" }} data-testid="gbrain-drain-msg">
            {drainMsg}
          </span>
        ) : null}
      </div>

      {health.warnings.length > 0 ? (
        <div
          style={{
            marginBottom: 12,
            padding: 8,
            background: "rgba(251, 191, 36, 0.10)",
            border: "1px solid var(--warn)",
            borderRadius: 4,
            fontSize: 11,
            color: "var(--warn)",
          }}
        >
          {health.warnings.map((w, i) => (
            <div key={i}>⚠ {w}</div>
          ))}
        </div>
      ) : null}

      {entries.length === 0 ? (
        <div className="empty">No snapshots queued for this flow yet.</div>
      ) : (
        <ul style={{ listStyle: "none", display: "flex", flexDirection: "column", gap: 4 }}>
          {entries.slice(0, 10).map((e, i) => {
            const time = formatTime(e.recorded_at);
            const subject =
              (e.payload.feature_id as string | undefined) ??
              (e.payload.milestone_id as string | undefined) ??
              (e.payload.goal as string | undefined)?.slice(0, 40) ??
              "—";
            return (
              <li
                key={`${e.file}-${i}`}
                style={{
                  display: "flex",
                  gap: 8,
                  padding: "4px 8px",
                  borderLeft: `2px solid ${SYNC_COLOR[e.sync_state]}`,
                  background: "var(--bg)",
                  borderRadius: 4,
                  fontSize: 12,
                }}
              >
                <code style={{ color: "var(--text-dim)", fontSize: 11 }}>{time}</code>
                <span style={{ color: SYNC_COLOR[e.sync_state], fontWeight: 600 }}>
                  {KIND_LABEL[e.kind] ?? e.kind}
                </span>
                <code>{subject}</code>
                <span style={{ marginLeft: "auto", color: "var(--text-dim)", fontSize: 10 }}>
                  {e.sync_state}
                </span>
              </li>
            );
          })}
        </ul>
      )}

      <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 12 }}>
        Mode: <strong>{mode}</strong> · Source: <code>{source_id}</code> · {total} snapshot{total === 1 ? "" : "s"} tracked
        {last_error ? (
          <span style={{ color: "var(--fail)" }}> · last error: {last_error}</span>
        ) : (
          <span> · last error: —</span>
        )}
      </div>
    </section>
  );
}

function StatChip({ count, label, color }: { count: number; label: string; color: string }) {
  return (
    <div
      style={{
        padding: "4px 10px",
        border: `1px solid var(--border)`,
        borderRadius: 999,
        fontSize: 11,
        color,
        background: "var(--bg-elev)",
      }}
    >
      <strong style={{ color: "var(--text)" }}>{count}</strong> · {label}
    </div>
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

function formatRelativeTime(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "—";
    const diff = Date.now() - d.getTime();
    if (diff < 60_000) return "just now";
    if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`;
    if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`;
    return d.toLocaleString();
  } catch {
    return "—";
  }
}

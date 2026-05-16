"use client";

import { useState, useEffect } from "react";

interface BackendInfo {
  name: string;
  available: boolean;
  note?: string;
}

interface TranscriptEntry {
  role: "user" | "assistant";
  content: string;
  recorded_at: string;
  ok?: boolean;
}

export default function AgentWorkbench() {
  const [backends, setBackends] = useState<BackendInfo[]>([]);
  const [selectedBackend, setSelectedBackend] = useState<string>("");
  const [goal, setGoal] = useState("");
  const [message, setMessage] = useState("");
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [busy, setBusy] = useState<"" | "chat" | "start" | "resume">("");
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string>("");

  useEffect(() => {
    fetch("/api/backends")
      .then((r) => r.json())
      .then((data: { backends: BackendInfo[] }) => {
        setBackends(data.backends);
        const firstAvail = data.backends.find((b) => b.available);
        if (firstAvail) setSelectedBackend(firstAvail.name);
        else if (data.backends.length) setSelectedBackend(data.backends[0]!.name);
      })
      .catch((e) => setError(`failed to load backends: ${e.message}`));
  }, []);

  const send = async () => {
    if (!message.trim() || busy) return;
    setBusy("chat");
    setError(null);
    try {
      const r = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          session_id: sessionId,
          backend: selectedBackend,
          message,
        }),
      });
      const data = await r.json();
      if (!r.ok || data.error) {
        setError(data.error || `HTTP ${r.status}`);
        return;
      }
      setSessionId(data.session_id);
      const now = new Date().toISOString();
      setTranscript((prev) => [
        ...prev,
        { role: "user", content: message, recorded_at: now },
        { role: "assistant", content: data.reply ?? "", recorded_at: now, ok: data.ok },
      ]);
      setMessage("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("");
    }
  };

  const startFlow = async () => {
    if (!goal.trim() || busy) return;
    setBusy("start");
    setError(null);
    setStatus("");
    try {
      const r = await fetch("/api/flows/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ goal, backend: selectedBackend }),
      });
      const data = await r.json();
      if (!r.ok || !data.ok) {
        const issues = (data.issues as string[] | undefined) ?? [];
        setError(
          (data.error || `HTTP ${r.status}`) +
            (issues.length ? "\n• " + issues.join("\n• ") : ""),
        );
        return;
      }
      setStatus(
        `Flow ${data.flow_id} created. ${data.milestones}M / ${data.features}F / ${data.assertions}A. Approve to run Phase 2.`,
      );
      setGoal("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("");
    }
  };

  const approveResume = async () => {
    if (busy) return;
    setBusy("resume");
    setError(null);
    try {
      const r = await fetch("/api/flows/resume", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ backend: selectedBackend }),
      });
      const data = await r.json();
      if (!r.ok || !data.ok) {
        setError(data.error || `HTTP ${r.status}`);
        return;
      }
      setStatus(
        `Flow ${data.flow_id} → ${data.status} (${data.iterations} iter${data.reason ? "; " + data.reason : ""})`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("");
    }
  };

  return (
    <section className="panel" data-testid="agent-workbench">
      <h2>Agent Workbench</h2>

      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 12 }}>
        <label style={{ fontSize: 12, color: "var(--text-dim)" }}>Backend</label>
        <select
          value={selectedBackend}
          onChange={(e) => setSelectedBackend(e.target.value)}
          disabled={busy !== ""}
          data-testid="backend-select"
          style={{ background: "var(--bg-elev)", color: "var(--text)", padding: "4px 8px", border: "1px solid var(--border)", borderRadius: 4 }}
        >
          {backends.map((b) => (
            <option key={b.name} value={b.name} disabled={!b.available}>
              {b.name}
              {!b.available ? ` (${b.note ?? "unavailable"})` : ""}
            </option>
          ))}
        </select>
        {busy ? (
          <span style={{ fontSize: 11, color: "var(--warn)" }}>● {busy}…</span>
        ) : null}
      </div>

      <div style={{ marginBottom: 16 }}>
        <textarea
          rows={3}
          placeholder="What do you want to build? (e.g., a static todo app with one input and a list…)"
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          disabled={busy !== ""}
          style={textareaStyle}
          data-testid="goal-textarea"
        />
        <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
          <button
            type="button"
            onClick={startFlow}
            disabled={busy !== "" || !goal.trim()}
            data-testid="start-flow-btn"
            style={btnStyle}
          >
            Start Flow
          </button>
          <button
            type="button"
            onClick={approveResume}
            disabled={busy !== ""}
            data-testid="approve-btn"
            style={btnStyle}
          >
            Approve / Resume
          </button>
        </div>
      </div>

      <div style={{ marginBottom: 8 }}>
        <textarea
          rows={2}
          placeholder="Chat with the agent (Cmd/Ctrl+Enter to send)"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void send();
            }
          }}
          disabled={busy !== ""}
          style={textareaStyle}
          data-testid="chat-textarea"
        />
        <button
          type="button"
          onClick={send}
          disabled={busy !== "" || !message.trim()}
          data-testid="send-btn"
          style={{ ...btnStyle, marginTop: 6 }}
        >
          {busy === "chat" ? "Working…" : "Send"}
        </button>
      </div>

      {error ? (
        <div
          data-testid="workbench-error"
          style={{
            background: "var(--fail)",
            color: "#1a0606",
            padding: 8,
            borderRadius: 4,
            marginBottom: 8,
            whiteSpace: "pre-wrap",
            fontSize: 12,
          }}
        >
          {error}
        </div>
      ) : null}

      {status ? (
        <div
          data-testid="workbench-status"
          style={{
            background: "var(--bg-elev)",
            padding: 8,
            borderRadius: 4,
            marginBottom: 8,
            fontSize: 12,
          }}
        >
          {status}
        </div>
      ) : null}

      <div data-testid="transcript" style={{ maxHeight: 360, overflowY: "auto" }}>
        {transcript.length === 0 ? (
          <div className="empty">No conversation yet. Pick a backend, type a message, and Send.</div>
        ) : (
          transcript.map((m, i) => (
            <div
              key={i}
              style={{
                marginBottom: 8,
                padding: 8,
                background: m.role === "user" ? "var(--bg-elev)" : "var(--bg)",
                borderLeft: `3px solid ${m.role === "user" ? "var(--accent)" : m.ok === false ? "var(--fail)" : "var(--border)"}`,
                borderRadius: 4,
              }}
            >
              <div style={{ fontSize: 11, color: "var(--text-dim)", marginBottom: 4 }}>
                {m.role}
              </div>
              <pre
                style={{
                  whiteSpace: "pre-wrap",
                  fontFamily: "inherit",
                  fontSize: 12,
                  margin: 0,
                }}
              >
                {m.content}
              </pre>
            </div>
          ))
        )}
      </div>
    </section>
  );
}

const textareaStyle: React.CSSProperties = {
  width: "100%",
  padding: 8,
  background: "var(--bg-elev)",
  color: "var(--text)",
  border: "1px solid var(--border)",
  borderRadius: 4,
  fontFamily: "inherit",
  fontSize: 13,
  resize: "vertical",
};

const btnStyle: React.CSSProperties = {
  padding: "6px 14px",
  background: "var(--accent)",
  color: "#0b0d10",
  border: "none",
  borderRadius: 4,
  fontWeight: 600,
  fontSize: 12,
  cursor: "pointer",
};

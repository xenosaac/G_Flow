"use client";

import { useEffect, useRef, useState } from "react";
import { parseCommand, HELP_TEXT } from "../lib/commands.ts";
import type { FlowSnapshot } from "../lib/snapshot.ts";

interface BackendInfo {
  name: string;
  available: boolean;
  note?: string;
}

interface TranscriptEntry {
  role: "user" | "assistant" | "system";
  content: string;
  ts: string;
  ok?: boolean;
}

const ROLE_LABEL: Record<TranscriptEntry["role"], string> = {
  user: "user  ",
  assistant: "agent ",
  system: "system",
};

export default function AgentWorkbench({
  snapshot,
}: {
  snapshot: FlowSnapshot | null;
}) {
  const [backends, setBackends] = useState<BackendInfo[]>([]);
  const [selectedBackend, setSelectedBackend] = useState<string>("");
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([
    { role: "system", content: HELP_TEXT, ts: new Date().toISOString() },
  ]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch("/api/backends")
      .then((r) => r.json())
      .then((data: { backends: BackendInfo[] }) => {
        setBackends(data.backends);
        const firstAvail = data.backends.find((b) => b.available);
        if (firstAvail) setSelectedBackend(firstAvail.name);
        else if (data.backends.length) setSelectedBackend(data.backends[0]!.name);
      })
      .catch((e) =>
        push({
          role: "system",
          content: `error loading /api/backends: ${e instanceof Error ? e.message : String(e)}`,
          ts: new Date().toISOString(),
          ok: false,
        }),
      );
  }, []);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [transcript]);

  function push(entry: TranscriptEntry) {
    setTranscript((prev) => [...prev, entry]);
  }

  function formatStatus(snap: FlowSnapshot | null): string {
    if (!snap) return "No active flow. Try /start <goal>.";
    const s = snap.state;
    const counts = snap.contract
      ? `${snap.contract.milestones.length}M / ${snap.contract.milestones.reduce((t, m) => t + m.features.length, 0)}F / ${snap.contract.milestones.reduce((t, m) => t + m.features.reduce((u, f) => u + f.assertions.length, 0), 0)}A`
      : "no contract yet";
    const line1 = `Flow ${snap.flow_id} · phase=${s.phase} · M=${s.current_milestone ?? "—"} · F=${s.current_feature ?? "—"} · step=${s.current_step ?? "—"}`;
    const line2 = counts;
    const hr =
      s.phase === "needs_human" && snap.needs_human_reason
        ? `\n⚠ ${snap.needs_human_reason}`
        : "";
    return `${line1}\n${line2}${hr}`;
  }

  async function submit() {
    const raw = input;
    const cmd = parseCommand(raw);
    if (!cmd) return;
    const now = new Date().toISOString();
    push({ role: "user", content: raw, ts: now });
    setInput("");
    setBusy(true);
    try {
      switch (cmd.kind) {
        case "help":
          push({ role: "system", content: HELP_TEXT, ts: new Date().toISOString() });
          break;
        case "status":
          push({
            role: "system",
            content: formatStatus(snapshot),
            ts: new Date().toISOString(),
          });
          break;
        case "start": {
          const r = await fetch("/api/flows/start", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ goal: cmd.goal, backend: selectedBackend }),
          });
          const d = await r.json();
          const ok = !!d.ok && r.ok;
          push({
            role: "system",
            content: ok
              ? `Flow ${d.flow_id} created. ${d.milestones}M / ${d.features}F / ${d.assertions}A. Run /resume to start Phase 2.`
              : `error: ${d.error ?? `HTTP ${r.status}`}${
                  (d.issues as string[] | undefined)?.length
                    ? "\n• " + (d.issues as string[]).join("\n• ")
                    : ""
                }`,
            ts: new Date().toISOString(),
            ok,
          });
          break;
        }
        case "resume": {
          const r = await fetch("/api/flows/resume", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ backend: selectedBackend }),
          });
          const d = await r.json();
          const ok = !!d.ok && r.ok;
          push({
            role: "system",
            content: ok
              ? `Flow ${d.flow_id} → ${d.status} (${d.iterations} iter${d.reason ? "; " + d.reason : ""})`
              : `error: ${d.error ?? `HTTP ${r.status}`}`,
            ts: new Date().toISOString(),
            ok,
          });
          break;
        }
        case "chat": {
          const r = await fetch("/api/chat", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              session_id: sessionId,
              backend: selectedBackend,
              message: cmd.text,
            }),
          });
          const d = await r.json();
          if (d.session_id) setSessionId(d.session_id);
          const ok = !!d.ok && r.ok;
          push({
            role: ok ? "assistant" : "system",
            content: ok ? (d.reply ?? "") : `error: ${d.error ?? `HTTP ${r.status}`}`,
            ts: new Date().toISOString(),
            ok,
          });
          break;
        }
        case "unknown":
          push({
            role: "system",
            content: `unknown command: ${cmd.name}. Try /help.`,
            ts: new Date().toISOString(),
            ok: false,
          });
          break;
      }
    } catch (e) {
      push({
        role: "system",
        content: `error: ${e instanceof Error ? e.message : String(e)}`,
        ts: new Date().toISOString(),
        ok: false,
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel" data-testid="agent-workbench">
      <h2>Agent Workbench</h2>

      <div
        style={{
          display: "flex",
          gap: 8,
          alignItems: "center",
          marginBottom: 12,
        }}
      >
        <label style={{ fontSize: 12, color: "var(--text-dim)" }}>Backend</label>
        <select
          value={selectedBackend}
          onChange={(e) => setSelectedBackend(e.target.value)}
          disabled={busy}
          data-testid="backend-select"
          style={{
            background: "var(--bg-elev)",
            color: "var(--text)",
            padding: "4px 8px",
            border: "1px solid var(--border)",
            borderRadius: 4,
          }}
        >
          {backends.map((b) => (
            <option key={b.name} value={b.name} disabled={!b.available}>
              {b.name}
              {!b.available ? ` (${b.note ?? "unavailable"})` : ""}
            </option>
          ))}
        </select>
        <span
          style={{
            marginLeft: "auto",
            fontSize: 11,
            color: busy ? "var(--warn)" : "var(--text-dim)",
          }}
        >
          {busy ? "● busy…" : "● idle"}
        </span>
      </div>

      <div
        ref={scrollRef}
        data-testid="workbench-transcript"
        style={{
          maxHeight: 480,
          overflowY: "auto",
          marginBottom: 12,
          background: "var(--bg)",
          border: "1px solid var(--border)",
          borderRadius: 4,
          padding: 12,
          fontSize: 12,
          fontFamily: "inherit",
        }}
      >
        {transcript.map((m, i) => (
          <div
            key={i}
            style={{
              marginBottom: 8,
              paddingLeft: 8,
              borderLeft: `2px solid ${
                m.ok === false
                  ? "var(--fail)"
                  : m.role === "user"
                    ? "var(--accent)"
                    : m.role === "assistant"
                      ? "var(--pass)"
                      : "var(--border)"
              }`,
            }}
          >
            <div
              style={{
                fontSize: 10,
                color: "var(--text-dim)",
                letterSpacing: "0.05em",
                marginBottom: 2,
                textTransform: "uppercase",
              }}
            >
              [{ROLE_LABEL[m.role]}]
            </div>
            <pre
              style={{
                whiteSpace: "pre-wrap",
                fontFamily: "inherit",
                fontSize: 12,
                margin: 0,
                color: m.ok === false ? "var(--fail)" : "var(--text)",
              }}
            >
              {m.content}
            </pre>
          </div>
        ))}
      </div>

      <textarea
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void submit();
          }
        }}
        disabled={busy}
        rows={4}
        placeholder="> type a message, or /start <goal>, /resume, /status, /help"
        data-testid="workbench-input"
        style={{
          width: "100%",
          padding: 10,
          background: "var(--bg-elev)",
          color: "var(--text)",
          border: "1px solid var(--border)",
          borderRadius: 4,
          fontFamily: "inherit",
          fontSize: 13,
          resize: "vertical",
        }}
      />
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginTop: 6,
        }}
      >
        <span style={{ fontSize: 11, color: "var(--text-dim)" }}>
          Cmd/Ctrl+Enter sends · Enter inserts newline
        </span>
        <button
          type="button"
          onClick={() => void submit()}
          disabled={busy || !input.trim()}
          data-testid="workbench-send"
          style={{
            padding: "6px 14px",
            background: "var(--accent)",
            color: "#0b0d10",
            border: "none",
            borderRadius: 4,
            fontWeight: 600,
            fontSize: 12,
            cursor: "pointer",
          }}
        >
          {busy ? "working…" : "send"}
        </button>
      </div>
    </section>
  );
}

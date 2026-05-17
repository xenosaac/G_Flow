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
  user: "You",
  assistant: "Agent",
  system: "system",
};

const SEED_BANNER: TranscriptEntry = {
  role: "system",
  content: HELP_TEXT,
  ts: new Date().toISOString(),
};

export default function AgentWorkbench({
  snapshot,
  onNewChat,
  onDemoLoaded,
}: {
  snapshot: FlowSnapshot | null;
  onNewChat?: () => void;
  onDemoLoaded?: (snapshot: FlowSnapshot) => void;
}) {
  const [backends, setBackends] = useState<BackendInfo[]>([]);
  const [selectedBackend, setSelectedBackend] = useState<string>("");
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([SEED_BANNER]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState<
    "" | "starting" | "clarifying" | "replanning" | "accepting" | "pausing" | "chatting" | "demoing"
  >("");
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

  function nowISO() {
    return new Date().toISOString();
  }

  function resetChat() {
    setTranscript([{ ...SEED_BANNER, ts: nowISO() }]);
    setSessionId(null);
    setInput("");
    onNewChat?.();
  }

  function clarificationsFromTranscript(latest: string): string {
    const earlier = transcript
      .filter((m) => m.role === "user")
      .map((m) => m.content);
    return [...earlier, latest].join("\n\n---\n\n");
  }

  function formatStatus(snap: FlowSnapshot | null): string {
    if (!snap) return "No active flow. Type a goal in the chat to start.";
    const s = snap.state;
    const counts = snap.contract
      ? `${snap.contract.milestones.length}M / ${snap.contract.milestones.reduce((t, m) => t + m.features.length, 0)}F / ${snap.contract.milestones.reduce((t, m) => t + m.features.reduce((u, f) => u + f.assertions.length, 0), 0)}A`
      : "no contract yet";
    const line1 = `Flow ${snap.flow_id} · phase=${s.phase} · M=${s.current_milestone ?? "—"} · F=${s.current_feature ?? "—"} · step=${s.current_step ?? "—"}`;
    const hr = s.phase === "needs_human" && snap.needs_human_reason ? `\n⚠ ${snap.needs_human_reason}` : "";
    const questions =
      s.phase === "clarifying" && snap.clarification_questions.length
        ? `\nQuestions:\n${snap.clarification_questions.map((q) => `- ${q.id}: ${q.text}`).join("\n")}`
        : "";
    return `${line1}\n${counts}${questions}${hr}`;
  }

  function formatQuestions(
    questions: { id: string; text: string; why?: string }[],
  ): string {
    if (!questions.length) return "(no questions returned)";
    return questions
      .map((q) => `- ${q.id}: ${q.text}${q.why ? `\n  why: ${q.why}` : ""}`)
      .join("\n");
  }

  async function acceptPlan() {
    if (busy) return;
    setBusy("accepting");
    try {
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
          ? `Plan accepted. Phase 2 → ${d.status} (${d.iterations} iter${d.reason ? "; " + d.reason : ""})`
          : `accept failed: ${d.error ?? `HTTP ${r.status}`}`,
        ts: nowISO(),
        ok,
      });
    } catch (e) {
      push({
        role: "system",
        content: `accept failed: ${e instanceof Error ? e.message : String(e)}`,
        ts: nowISO(),
        ok: false,
      });
    } finally {
      setBusy("");
    }
  }

  async function pauseFlow() {
    if (busy || !snapshot) return;
    setBusy("pausing");
    try {
      const r = await fetch("/api/flows/pause", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          flow_id: snapshot.flow_id,
          reason: "requested from Workbench",
        }),
      });
      const d = await r.json();
      const ok = !!d.ok && r.ok;
      push({
        role: "system",
        content: ok
          ? `Pause requested. Flow ${d.flow_id} → ${d.status}.`
          : `pause failed: ${d.error ?? `HTTP ${r.status}`}`,
        ts: nowISO(),
        ok,
      });
    } catch (e) {
      push({
        role: "system",
        content: `pause failed: ${e instanceof Error ? e.message : String(e)}`,
        ts: nowISO(),
        ok: false,
      });
    } finally {
      setBusy("");
    }
  }

  async function runCollegeDemo() {
    if (busy) return;
    setBusy("demoing");
    try {
      const r = await fetch("/api/demo/college-website", {
        method: "POST",
        headers: { "content-type": "application/json" },
      });
      const d = await r.json();
      const ok = !!d.ok && r.ok;
      if (ok && d.snapshot) {
        onDemoLoaded?.(d.snapshot as FlowSnapshot);
      }
      push({
        role: "system",
        content: ok
          ? [
              `College website demo loaded · flow ${d.flow_id}.`,
              `${d.milestones}M / ${d.features}F / ${d.assertions}A · target: ${d.target_dir}`,
              "Planner artifacts, validator reports, and GBrain snapshots are now visible in the panels.",
            ].join("\n")
          : `demo failed: ${d.error ?? `HTTP ${r.status}`}`,
        ts: nowISO(),
        ok,
      });
    } catch (e) {
      push({
        role: "system",
        content: `demo failed: ${e instanceof Error ? e.message : String(e)}`,
        ts: nowISO(),
        ok: false,
      });
    } finally {
      setBusy("");
    }
  }

  async function submit() {
    const raw = input.trim();
    if (!raw || busy) return;
    const cmd = parseCommand(raw);
    if (!cmd) return;

    // Slash commands that handle themselves entirely on the client
    if (cmd.kind === "new") {
      resetChat();
      return;
    }
    if (cmd.kind === "help") {
      push({ role: "user", content: raw, ts: nowISO() });
      setInput("");
      push({ role: "system", content: HELP_TEXT, ts: nowISO() });
      return;
    }
    if (cmd.kind === "status") {
      push({ role: "user", content: raw, ts: nowISO() });
      setInput("");
      push({ role: "system", content: formatStatus(snapshot), ts: nowISO() });
      return;
    }
    if (cmd.kind === "unknown") {
      push({ role: "user", content: raw, ts: nowISO() });
      setInput("");
      push({
        role: "system",
        content: `unknown command: ${cmd.name}. Try /help.`,
        ts: nowISO(),
        ok: false,
      });
      return;
    }

    // Everything else hits the server. Echo the user input first.
    push({ role: "user", content: raw, ts: nowISO() });
    setInput("");

    // Slash overrides for /resume + /start
    if (cmd.kind === "resume") {
      await acceptPlan();
      return;
    }
    if (cmd.kind === "pause") {
      await pauseFlow();
      return;
    }
    if (cmd.kind === "start") {
      await runStart(cmd.goal);
      return;
    }

    // cmd.kind === "chat" — route based on phase
    const phase = snapshot?.state.phase;
    const hasContract = !!snapshot?.contract;
    if (!snapshot) {
      // First message ever → start a flow with this as the goal
      await runStart(cmd.text);
      return;
    }
    if (phase === "clarifying") {
      await runClarify(cmd.text);
      return;
    }
    if (phase === "planning") {
      if (!hasContract) {
        // Replan needs contract.yaml to exist; if Planner is still on its first pass,
        // start instead (mints + plans).
        await runStart(cmd.text);
        return;
      }
      await runReplan(cmd.text);
      return;
    }
    // executing / complete / needs_human → Q&A
    await runChat(cmd.text);
  }

  async function runStart(goal: string) {
    setBusy("starting");
    try {
      const r = await fetch("/api/flows/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ goal, backend: selectedBackend }),
      });
      const d = await r.json();
      const ok = !!d.ok && r.ok;
      push({
        role: "system",
        content: ok && d.status === "needs_clarification"
          ? `Clarification needed · flow ${d.flow_id}.\n${formatQuestions(d.questions ?? [])}`
          : ok
            ? `Plan v1 ready · flow ${d.flow_id} · ${d.milestones}M / ${d.features}F / ${d.assertions}A.\nReview the Plan panel on the right, refine in chat, or click Accept Plan.`
          : `start failed: ${d.error ?? `HTTP ${r.status}`}${
              (d.issues as string[] | undefined)?.length ? "\n• " + (d.issues as string[]).join("\n• ") : ""
            }`,
        ts: nowISO(),
        ok,
      });
    } catch (e) {
      push({
        role: "system",
        content: `start failed: ${e instanceof Error ? e.message : String(e)}`,
        ts: nowISO(),
        ok: false,
      });
    } finally {
      setBusy("");
    }
  }

  async function runClarify(answer: string) {
    if (!snapshot) return;
    setBusy("clarifying");
    const questions = snapshot.clarification_questions.length
      ? snapshot.clarification_questions
      : [{ id: "freeform", text: "Clarification", why: "" }];
    try {
      const r = await fetch("/api/flows/clarify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          flow_id: snapshot.flow_id,
          backend: selectedBackend,
          answers: questions.map((q) => ({
            question_id: q.id,
            answer,
          })),
        }),
      });
      const d = await r.json();
      const ok = !!d.ok && r.ok;
      push({
        role: "system",
        content: ok && d.status === "needs_clarification"
          ? `More clarification needed.\n${formatQuestions(d.questions ?? [])}`
          : ok
            ? `Plan ready · ${d.milestones}M / ${d.features}F / ${d.assertions}A.\nReview the Plan panel on the right, refine in chat, or click Accept Plan.`
            : `clarify failed: ${d.error ?? `HTTP ${r.status}`}${
                (d.issues as string[] | undefined)?.length ? "\n• " + (d.issues as string[]).join("\n• ") : ""
              }`,
        ts: nowISO(),
        ok,
      });
    } catch (e) {
      push({
        role: "system",
        content: `clarify failed: ${e instanceof Error ? e.message : String(e)}`,
        ts: nowISO(),
        ok: false,
      });
    } finally {
      setBusy("");
    }
  }

  async function runReplan(latestMessage: string) {
    if (!snapshot) return;
    setBusy("replanning");
    try {
      const r = await fetch("/api/flows/replan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          flow_id: snapshot.flow_id,
          backend: selectedBackend,
          clarifications: clarificationsFromTranscript(latestMessage),
        }),
      });
      const d = await r.json();
      const ok = !!d.ok && r.ok;
      push({
        role: "system",
        content: ok
          ? `Plan revised · ${d.milestones}M / ${d.features}F / ${d.assertions}A.\nKeep refining or click Accept Plan.`
          : `revise failed: ${d.error ?? `HTTP ${r.status}`}${
              (d.issues as string[] | undefined)?.length ? "\n• " + (d.issues as string[]).join("\n• ") : ""
            }`,
        ts: nowISO(),
        ok,
      });
    } catch (e) {
      push({
        role: "system",
        content: `revise failed: ${e instanceof Error ? e.message : String(e)}`,
        ts: nowISO(),
        ok: false,
      });
    } finally {
      setBusy("");
    }
  }

  async function runChat(message: string) {
    setBusy("chatting");
    try {
      const r = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          session_id: sessionId,
          backend: selectedBackend,
          flow_id: snapshot?.flow_id,
          message,
        }),
      });
      const d = await r.json();
      if (d.session_id) setSessionId(d.session_id);
      const ok = !!d.ok && r.ok;
      push({
        role: ok ? "assistant" : "system",
        content: ok ? (d.reply ?? "") : `chat failed: ${d.error ?? `HTTP ${r.status}`}`,
        ts: nowISO(),
        ok,
      });
    } catch (e) {
      push({
        role: "system",
        content: `chat failed: ${e instanceof Error ? e.message : String(e)}`,
        ts: nowISO(),
        ok: false,
      });
    } finally {
      setBusy("");
    }
  }

  // Accept Plan button enabled iff there's a contract on disk AND we're still in planning
  const canAccept =
    !!snapshot &&
    snapshot.state.phase === "planning" &&
    !!snapshot.contract &&
    !busy;
  const acceptLabel = (() => {
    if (!snapshot) return "Accept Plan";
    const phase = snapshot.state.phase;
    if (phase === "planning") {
      return snapshot.contract ? "Accept Plan" : "Awaiting first plan…";
    }
    return "Plan Accepted";
  })();
  const phase = snapshot?.state.phase ?? "idle";
  const primaryLabel = busy
    ? busy === "starting"
      ? "Starting…"
      : busy === "clarifying"
        ? "Answering…"
      : busy === "replanning"
        ? "Refining…"
      : busy === "pausing"
        ? "Pausing…"
      : busy === "demoing"
        ? "Loading demo…"
      : busy === "chatting"
        ? "Sending…"
        : "Working…"
    : !snapshot
      ? "Start Flow"
      : phase === "clarifying"
        ? "Answer"
      : phase === "planning"
        ? "Refine Plan"
        : "Send";
  const modeLabel =
    phase === "clarifying"
      ? "Clarifying"
      : phase === "planning"
      ? "Plan mode"
      : phase === "executing"
        ? "Execution"
        : phase === "paused"
          ? "Paused"
        : phase === "needs_human"
          ? "Needs review"
          : phase === "complete"
            ? "Complete"
            : "Ready";

  return (
    <section className="panel workbench-panel" data-testid="agent-workbench">
      <div className="workbench-header">
        <div className="panel-title-block">
          <h2>Agent Workbench</h2>
          <span className={`mode-chip mode-${phase}`}>{modeLabel}</span>
        </div>
        <button
          type="button"
          onClick={resetChat}
          disabled={!!busy}
          className="btn ghost"
          data-testid="workbench-new-chat"
        >
          + New Chat
        </button>
        <button
          type="button"
          onClick={() => void runCollegeDemo()}
          disabled={!!busy}
          className="btn ghost"
          data-testid="workbench-college-demo"
        >
          College Demo
        </button>
        <button
          type="button"
          onClick={() => void acceptPlan()}
          disabled={!canAccept}
          className="btn primary"
          data-testid="workbench-accept-plan"
        >
          {busy === "accepting" ? "Accepting…" : acceptLabel}
        </button>
        {snapshot?.state.phase === "executing" || snapshot?.state.phase === "paused" ? (
          <button
            type="button"
            onClick={() =>
              snapshot?.state.phase === "paused"
                ? void acceptPlan()
                : void pauseFlow()
            }
            disabled={!!busy}
            className="btn ghost"
            data-testid="workbench-pause"
          >
            {snapshot?.state.phase === "paused"
              ? busy === "accepting"
                ? "Resuming…"
                : "Resume"
              : busy === "pausing"
                ? "Pausing…"
                : "Pause"}
          </button>
        ) : null}
        <div className="workbench-spacer" />
        <div className="backend-controls">
          <label className="select-label" htmlFor="backend-select">
            Backend
          </label>
          <select
            id="backend-select"
            value={selectedBackend}
            onChange={(e) => setSelectedBackend(e.target.value)}
            disabled={!!busy}
            data-testid="backend-select"
            className="select-control"
          >
            {backends.map((b) => (
              <option key={b.name} value={b.name} disabled={!b.available}>
                {b.name}
                {!b.available ? ` (${b.note ?? "unavailable"})` : ""}
              </option>
            ))}
          </select>
          <span className={`run-state ${busy ? "active" : ""}`}>
            <span className="state-dot" />
            {busy || "idle"}
          </span>
        </div>
      </div>

      <div
        ref={scrollRef}
        data-testid="workbench-transcript"
        className="transcript"
      >
        {transcript.map((m, i) => (
          <div
            key={i}
            className={[
              "transcript-entry",
              `entry-${m.role}`,
              m.ok === false ? "entry-error" : "",
            ]
              .filter(Boolean)
              .join(" ")}
          >
            <div className="entry-label">{ROLE_LABEL[m.role]}</div>
            <pre className="entry-body">
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
        disabled={!!busy}
        rows={4}
        placeholder={
          !snapshot
            ? "> describe what you want to build, then Cmd/Ctrl+Enter to send"
            : snapshot.state.phase === "clarifying"
              ? "> answer the clarification questions above"
            : snapshot.state.phase === "planning"
              ? "> refine the plan — every message rewrites the contract until you Accept"
              : snapshot.state.phase === "paused"
                ? "> flow is paused; ask a question or click Resume"
              : "> ask the agent anything; Phase 2 is running"
        }
        data-testid="workbench-input"
        className="workbench-input"
      />
      <div className="workbench-footer">
        <span className="workbench-hint">
          {snapshot?.state.phase === "planning"
            ? "Plan Mode · every message rewrites the contract"
            : snapshot?.state.phase === "clarifying"
              ? "Clarifying · answer in chat to create the plan"
            : snapshot?.state.phase === "executing"
              ? "Executing · messages route to /api/chat"
              : "Cmd/Ctrl+Enter sends · /help for commands"}
        </span>
        <button
          type="button"
          onClick={() => void submit()}
          disabled={!!busy || !input.trim()}
          data-testid="workbench-send"
          className="btn primary"
        >
          {primaryLabel}
        </button>
      </div>
    </section>
  );
}

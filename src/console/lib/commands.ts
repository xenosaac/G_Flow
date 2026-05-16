/**
 * Pure slash-command parser for the Agent Workbench.
 *
 * The Workbench is a CLI-style single-input chat: plain text → /api/chat,
 * /<command> → flow-orchestration actions. Keeping this pure makes the
 * dispatcher trivial to unit-test (tests/commands.test.ts).
 */

export type Cmd =
  | { kind: "chat"; text: string }
  | { kind: "start"; goal: string }
  | { kind: "resume" }
  | { kind: "status" }
  | { kind: "help" }
  | { kind: "unknown"; name: string };

export function parseCommand(raw: string): Cmd | null {
  const t = raw.trim();
  if (!t) return null;
  if (!t.startsWith("/")) return { kind: "chat", text: t };
  const head = (t.slice(1).split(/\s+/, 1)[0] ?? "").toLowerCase();
  const arg = t.slice(1 + head.length).trim();
  switch (head) {
    case "start":
      return arg ? { kind: "start", goal: arg } : { kind: "unknown", name: "start (missing <goal>)" };
    case "resume":
    case "approve":
      return { kind: "resume" };
    case "status":
      return { kind: "status" };
    case "help":
    case "?":
      return { kind: "help" };
    case "":
      // bare "/" with whitespace after — treat as unknown
      return { kind: "unknown", name: "(empty)" };
    default:
      return { kind: "unknown", name: head };
  }
}

export const HELP_TEXT = `G_FLOW console — type a message to chat with the selected backend, or use a slash command:
  /start <goal>   Create a new flow from a goal (runs the Planner)
  /resume         Approve the current phase or resume after needs_human
  /approve        Alias for /resume
  /status         Print the current flow snapshot
  /help           Show this message

Cmd/Ctrl+Enter sends · Enter inserts a newline`;

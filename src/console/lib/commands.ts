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
  | { kind: "new" }
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
    case "new":
    case "clear":
      return { kind: "new" };
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

export const HELP_TEXT = `G_FLOW console — Plan Mode is the default.

In Plan Mode every message refines the contract — the right column updates after
each send. Click "Accept Plan" when you are happy with the milestones tree.
After acceptance Phase 2 runs autonomously; further messages become Q&A.

Slash commands:
  /start <goal>   Mint a flow even when one already exists
  /resume         Force "Accept Plan" (same as the button)
  /approve        Alias for /resume
  /status         Print the current flow snapshot
  /new, /clear    Start a fresh chat (does not touch the flow on disk)
  /help           Show this message

Cmd/Ctrl+Enter sends · Enter inserts a newline`;

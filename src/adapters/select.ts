import type { AgentBackend } from "./backend.ts";

export class UnknownBackendError extends Error {
  constructor(public readonly value: string) {
    super(
      `Unknown GFLOW_BACKEND="${value}". Expected one of: claude-code, codex, none.`,
    );
    this.name = "UnknownBackendError";
  }
}

export const KNOWN_BACKENDS = ["claude-code", "codex", "none"] as const;
export type KnownBackend = (typeof KNOWN_BACKENDS)[number];

/**
 * Resolve a backend by name. Unknown names throw UnknownBackendError; "none"
 * / "off" return null. No silent fallback.
 */
export async function selectBackend(name?: string): Promise<AgentBackend | null> {
  const choice = (name ?? "claude-code").toLowerCase();
  if (choice === "none" || choice === "off") return null;
  if (choice === "claude-code") {
    const { ClaudeCodeBackend } = await import("./claude-code.ts");
    return new ClaudeCodeBackend();
  }
  if (choice === "codex") {
    const { CodexBackend } = await import("./codex.ts");
    return new CodexBackend();
  }
  throw new UnknownBackendError(choice);
}

/** Same as selectBackend(undefined) but reads GFLOW_BACKEND env. */
export async function defaultBackend(): Promise<AgentBackend | null> {
  return selectBackend(process.env.GFLOW_BACKEND);
}

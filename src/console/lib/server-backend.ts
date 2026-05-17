import { execFileSync } from "node:child_process";

/** Probe whether a CLI binary is on PATH. Works under both Bun and Node. */
export function isBinaryAvailable(name: string): boolean {
  try {
    execFileSync("which", [name], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export interface BackendInfo {
  name: string;
  available: boolean;
  note?: string;
}

export function listBackends(): BackendInfo[] {
  return [
    {
      name: "claude-code",
      available: isBinaryAvailable("claude"),
      note: isBinaryAvailable("claude") ? undefined : "claude CLI not on PATH",
    },
    {
      name: "codex",
      available: isBinaryAvailable("codex"),
      note: isBinaryAvailable("codex") ? undefined : "codex CLI not on PATH",
    },
  ];
}

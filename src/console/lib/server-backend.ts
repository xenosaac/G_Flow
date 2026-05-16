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
  // OpenCloud is a V1 stub (throws on any call). Hiding from the UI so the
  // operator can't pick it by accident. The runtime adapter still exists for
  // tests + future wiring (TODOS T1).
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

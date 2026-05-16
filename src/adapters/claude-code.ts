import type { AgentBackend, AgentRunRequest, AgentRunResult } from "./backend.ts";
import { spawnPiped } from "./spawn.ts";

/**
 * ClaudeCodeBackend — shells out to the `claude` CLI in headless print mode.
 *
 * Invocation: `claude -p` reads stdin as the prompt and emits the model's
 * response on stdout. A nonzero exit code or AbortController timeout returns
 * ok=false; the caller (Planner / Worker / Steward) decides how to interpret.
 */
export class ClaudeCodeBackend implements AgentBackend {
  readonly name = "claude-code";

  constructor(private readonly options: { binary?: string } = {}) {}

  async run(req: AgentRunRequest): Promise<AgentRunResult> {
    const binary = this.options.binary ?? process.env.GFLOW_CLAUDE_BIN ?? "claude";
    return spawnPiped([binary, "-p"], {
      cwd: req.cwd,
      env: { ...process.env, ...(req.env ?? {}) },
      timeoutMs: req.timeoutMs,
      stdin: req.prompt,
    });
  }
}

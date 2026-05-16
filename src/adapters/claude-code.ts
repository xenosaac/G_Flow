import type { AgentBackend, AgentRunRequest, AgentRunResult } from "./backend.ts";

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
    const args = ["-p"];
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, req.timeoutMs);

    try {
      const proc = Bun.spawn([binary, ...args], {
        cwd: req.cwd,
        env: { ...process.env, ...(req.env ?? {}) },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        signal: controller.signal,
      });

      proc.stdin.write(req.prompt);
      proc.stdin.end();

      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      const exitCode = await proc.exited;

      return {
        ok: !timedOut && exitCode === 0,
        exitCode: timedOut ? null : exitCode,
        stdout,
        stderr,
        timedOut,
      };
    } catch (err) {
      return {
        ok: false,
        exitCode: null,
        stdout: "",
        stderr: err instanceof Error ? err.message : String(err),
        timedOut,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

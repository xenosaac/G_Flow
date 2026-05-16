import type { AgentBackend, AgentRunRequest, AgentRunResult } from "./backend.ts";

/**
 * CodexBackend — shells out to the `codex` CLI in headless exec mode.
 *
 * Invocation:
 *   codex exec --skip-git-repo-check -C <cwd> \
 *              --sandbox workspace-write --ask-for-approval never -
 *
 * - The trailing `-` makes codex read the prompt from stdin.
 * - `--sandbox workspace-write` restricts edits to the supplied cwd, matching
 *   G_Flow's "worker writes only inside target_dir" rule.
 * - `--ask-for-approval never` keeps the run headless (no TTY prompts).
 * - `--skip-git-repo-check` lets us drive into a freshly-created target_dir
 *   that may not yet be a git repo.
 *
 * Behavior on subprocess error / timeout matches ClaudeCodeBackend: timedOut
 * + exitCode=null with the AbortController fired.
 */
export class CodexBackend implements AgentBackend {
  readonly name = "codex";

  constructor(private readonly options: { binary?: string } = {}) {}

  async run(req: AgentRunRequest): Promise<AgentRunResult> {
    const binary = this.options.binary ?? process.env.GFLOW_CODEX_BIN ?? "codex";
    const args = [
      "exec",
      "--skip-git-repo-check",
      "-C",
      req.cwd,
      "--sandbox",
      "workspace-write",
      "--ask-for-approval",
      "never",
      "-",
    ];
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

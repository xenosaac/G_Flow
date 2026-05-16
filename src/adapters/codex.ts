import type { AgentBackend, AgentRunRequest, AgentRunResult } from "./backend.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile, unlink } from "node:fs/promises";
import { spawnPiped } from "./spawn.ts";

/**
 * CodexBackend — shells out to the `codex` CLI in headless exec mode.
 *
 * Invocation (codex-cli ≥ 0.130):
 *   codex exec --skip-git-repo-check -C <cwd> --sandbox workspace-write \
 *              -o <tempfile> -
 *
 * - `codex exec` is already non-interactive (no approval prompts).
 * - `-` reads the prompt from stdin.
 * - `--sandbox workspace-write` restricts edits to the supplied cwd, matching
 *   G_Flow's "worker writes only inside target_dir" rule.
 * - `--skip-git-repo-check` lets us drive into a freshly-created target_dir.
 * - `-o <tempfile>` writes the agent's final message ONLY (no session header,
 *   no token report). We read that file back as `stdout` so Planner / Steward
 *   JSON parsers work without scrubbing the verbose CLI framing.
 *
 * Behavior on subprocess error / timeout matches ClaudeCodeBackend: timedOut
 * + exitCode=null with the AbortController fired.
 */
export class CodexBackend implements AgentBackend {
  readonly name = "codex";

  constructor(private readonly options: { binary?: string } = {}) {}

  async run(req: AgentRunRequest): Promise<AgentRunResult> {
    const binary = this.options.binary ?? process.env.GFLOW_CODEX_BIN ?? "codex";
    const lastMsgPath = join(
      tmpdir(),
      `gflow-codex-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`,
    );
    const args = [
      "exec",
      "--skip-git-repo-check",
      "-C",
      req.cwd,
      "--sandbox",
      "workspace-write",
      "-o",
      lastMsgPath,
      "-",
    ];
    const result = await spawnPiped([binary, ...args], {
      cwd: req.cwd,
      env: { ...process.env, ...(req.env ?? {}) },
      timeoutMs: req.timeoutMs,
      stdin: req.prompt,
    });

    let cleanOut = "";
    try {
      cleanOut = await readFile(lastMsgPath, "utf8");
    } catch {
      // If -o never wrote (e.g., crash before completion), fall back to the
      // verbose stdout. Planner/Steward parsers may still recover.
      cleanOut = result.stdout;
    }
    await unlink(lastMsgPath).catch(() => undefined);

    return {
      ok: result.ok,
      exitCode: result.exitCode,
      stdout: cleanOut,
      stderr:
        result.stderr +
        (result.stdout && cleanOut !== result.stdout
          ? `\n--- codex verbose stdout ---\n${result.stdout}`
          : ""),
      timedOut: result.timedOut,
    };
  }
}

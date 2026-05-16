import { spawn } from "node:child_process";

/**
 * Runtime-agnostic subprocess helper.
 *
 * Bun.spawn() only exists in Bun's global scope; Next.js dev/build runs route
 * handlers under Node.js, so calling Bun.spawn inside an API route blew up
 * with "Bun is not defined". node:child_process.spawn works in BOTH runtimes
 * (Bun has full Node-compat for it), so every G_Flow adapter routes through
 * this helper instead.
 */
export interface SpawnResult {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface SpawnOptions {
  cwd: string;
  env?: Record<string, string | undefined>;
  timeoutMs: number;
  /** When set, written to the child's stdin then closed. */
  stdin?: string;
}

export async function spawnPiped(
  argv: string[],
  opts: SpawnOptions,
): Promise<SpawnResult> {
  if (argv.length === 0) {
    return { ok: false, exitCode: null, stdout: "", stderr: "empty argv", timedOut: false };
  }
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, opts.timeoutMs);

  return new Promise<SpawnResult>((resolve) => {
    let resolved = false;
    const finish = (r: SpawnResult) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      resolve(r);
    };

    let child;
    try {
      child = spawn(argv[0]!, argv.slice(1), {
        cwd: opts.cwd,
        env: opts.env as NodeJS.ProcessEnv | undefined,
        stdio: ["pipe", "pipe", "pipe"],
        signal: controller.signal,
      });
    } catch (err) {
      finish({
        ok: false,
        exitCode: null,
        stdout: "",
        stderr: err instanceof Error ? err.message : String(err),
        timedOut,
      });
      return;
    }

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
    });

    if (opts.stdin !== undefined && child.stdin) {
      try {
        child.stdin.write(opts.stdin);
        child.stdin.end();
      } catch {
        // Ignore EPIPE etc.; child will report via its own exit.
      }
    }

    child.on("close", (code) => {
      finish({
        ok: !timedOut && code === 0,
        exitCode: timedOut ? null : code,
        stdout,
        stderr,
        timedOut,
      });
    });

    child.on("error", (err) => {
      finish({
        ok: false,
        exitCode: null,
        stdout,
        stderr: (stderr ? stderr + "\n" : "") + err.message,
        timedOut,
      });
    });
  });
}

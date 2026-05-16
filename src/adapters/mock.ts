import type { AgentBackend, AgentRunRequest, AgentRunResult } from "./backend.ts";

export type MockResponder = (
  req: AgentRunRequest,
  callIndex: number,
) => Partial<AgentRunResult> & { stdout: string };

/**
 * MockBackend — deterministic test fixture for the runtime.
 *
 * The responder receives each request + its 0-based call index and returns a
 * partial AgentRunResult (only `stdout` is required). Defaults fill in:
 *   ok=true, exitCode=0, stderr="", timedOut=false.
 *
 * Use this in tests; it never spawns a subprocess.
 */
export class MockBackend implements AgentBackend {
  readonly name = "mock";
  public readonly calls: AgentRunRequest[] = [];

  constructor(private readonly responder: MockResponder) {}

  async run(req: AgentRunRequest): Promise<AgentRunResult> {
    const idx = this.calls.length;
    this.calls.push(req);
    const partial = this.responder(req, idx);
    return {
      ok: partial.ok ?? true,
      exitCode: partial.exitCode ?? 0,
      stdout: partial.stdout,
      stderr: partial.stderr ?? "",
      timedOut: partial.timedOut ?? false,
    };
  }
}

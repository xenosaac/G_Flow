import type { AgentBackend, AgentRunRequest, AgentRunResult } from "./backend.ts";

/**
 * OpenCloudBackend — V2 stub.
 *
 * Required integration surface when implemented (TODOS T1):
 * - Authenticate against OpenCloud (org token or per-user OAuth).
 * - POST request.prompt to /v1/agents/run with role-specific routing.
 * - Stream or poll the response and map it to AgentRunResult.
 * - Honor request.timeoutMs via abort signal; on timeout return ok=false,
 *   exitCode=null, timedOut=true.
 * - Forward request.env as user-supplied secrets (do not log).
 *
 * For Hackathon V1, this backend throws on every invocation so callers can
 * detect "agent-agnostic" gaps loudly instead of silently degrading.
 */
export class OpenCloudBackend implements AgentBackend {
  readonly name = "opencloud-stub";

  async run(_req: AgentRunRequest): Promise<AgentRunResult> {
    throw new Error(
      "OpenCloudBackend is not implemented in Hackathon V1. " +
        "Use ClaudeCodeBackend, or set GFLOW_BACKEND=mock for tests. " +
        "See TODOS.md task T1.",
    );
  }
}

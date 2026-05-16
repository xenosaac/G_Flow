export type AgentRole = "planner" | "worker" | "steward" | "chat";

export type AgentRunRequest = {
  role: AgentRole;
  prompt: string;
  cwd: string;
  timeoutMs: number;
  env?: Record<string, string>;
};

export type AgentRunResult = {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

export interface AgentBackend {
  readonly name: string;
  run(request: AgentRunRequest): Promise<AgentRunResult>;
}

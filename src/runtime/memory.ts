import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { gflowRoot } from "./state.ts";

export interface RetrievedContext {
  title: string;
  body: string;
  source: string;
  score: number;
}

export interface MemoryProvider {
  retrieveContext(input: {
    flow_id?: string;
    query: string;
    limit: number;
  }): Promise<RetrievedContext[]>;
  writeSummary(input: {
    session_id: string;
    flow_id?: string;
    summary: string;
    covered_message_ids: string[];
  }): Promise<void>;
  recordEvent?(event: unknown): Promise<void>;
}

export const LocalSummary = z.object({
  session_id: z.string().min(1),
  flow_id: z.string().optional(),
  summary: z.string(),
  covered_message_ids: z.array(z.string()).default([]),
  updated_at: z.string(),
});
export type LocalSummaryT = z.infer<typeof LocalSummary>;

export class LocalMemoryProvider implements MemoryProvider {
  constructor(
    private readonly sessionId: string,
    private readonly root: string = gflowRoot(),
  ) {}

  async retrieveContext(input: {
    flow_id?: string;
    query: string;
    limit: number;
  }): Promise<RetrievedContext[]> {
    const summary = await readLocalSummary(this.sessionId, this.root);
    if (!summary || !summary.summary.trim()) return [];
    if (input.flow_id && summary.flow_id && input.flow_id !== summary.flow_id) {
      return [];
    }
    return [
      {
        title: "Local chat summary",
        body: summary.summary,
        source: summaryPath(this.sessionId, this.root),
        score: 1,
      },
    ].slice(0, input.limit);
  }

  async writeSummary(input: {
    session_id: string;
    flow_id?: string;
    summary: string;
    covered_message_ids: string[];
  }): Promise<void> {
    const payload: LocalSummaryT = {
      session_id: input.session_id,
      flow_id: input.flow_id,
      summary: input.summary,
      covered_message_ids: input.covered_message_ids,
      updated_at: new Date().toISOString(),
    };
    await atomicWrite(
      summaryPath(input.session_id, this.root),
      JSON.stringify(LocalSummary.parse(payload), null, 2) + "\n",
    );
  }

  async recordEvent(_event: unknown): Promise<void> {
    return;
  }
}

export function summaryPath(
  sessionId: string,
  root: string = gflowRoot(),
): string {
  return join(root, "chat", `${sessionId}.summary.json`);
}

export async function readLocalSummary(
  sessionId: string,
  root: string = gflowRoot(),
): Promise<LocalSummaryT | null> {
  try {
    const raw = await readFile(summaryPath(sessionId, root), "utf8");
    return LocalSummary.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  await writeFile(tmp, content, "utf8");
  await rename(tmp, path);
}

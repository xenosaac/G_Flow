import { mkdir, readFile, writeFile, rename, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { AgentBackend } from "../adapters/backend.ts";
import { flowDir, gflowRoot, readState } from "./state.ts";
import { readContractYaml } from "./contract-io.ts";
import {
  LocalMemoryProvider,
  type MemoryProvider,
  type RetrievedContext,
} from "./memory.ts";

export const ChatMessage = z.object({
  role: z.enum(["user", "assistant", "system"]),
  content: z.string(),
  backend: z.string().min(1),
  recorded_at: z.string(),
  ok: z.boolean().optional(),
  exit_code: z.number().int().nullable().optional(),
});
export type ChatMessageT = z.infer<typeof ChatMessage>;

export const ChatTranscript = z.object({
  session_id: z.string().min(1),
  backend: z.string().min(1),
  created_at: z.string(),
  messages: z.array(ChatMessage).default([]),
});
export type ChatTranscriptT = z.infer<typeof ChatTranscript>;

const CHAT_TIMEOUT_MS = 120_000;

export function chatDir(root: string = gflowRoot()): string {
  return join(root, "chat");
}

export function chatPath(session_id: string, root: string = gflowRoot()): string {
  return join(chatDir(root), `${session_id}.json`);
}

export async function readTranscript(
  session_id: string,
  root: string = gflowRoot(),
): Promise<ChatTranscriptT | null> {
  try {
    const raw = await readFile(chatPath(session_id, root), "utf8");
    return ChatTranscript.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

export async function writeTranscript(
  transcript: ChatTranscriptT,
  root: string = gflowRoot(),
): Promise<void> {
  const validated = ChatTranscript.parse(transcript);
  const path = chatPath(validated.session_id, root);
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  await writeFile(tmp, JSON.stringify(validated, null, 2) + "\n", "utf8");
  await rename(tmp, path);
}

export async function listSessions(root: string = gflowRoot()): Promise<string[]> {
  try {
    const files = await readdir(chatDir(root));
    return files
      .filter((f) => f.endsWith(".json") && !f.endsWith(".summary.json") && !f.includes(".tmp."))
      .map((f) => f.slice(0, -5))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

export function newSessionId(now: Date = new Date()): string {
  const ts = now.toISOString().replace(/[:.]/g, "-");
  const rand = Math.floor(Math.random() * 10000).toString().padStart(4, "0");
  return `s_${ts}_${rand}`;
}

export interface SendChatInput {
  session_id: string;
  backend: AgentBackend;
  message: string;
  cwd: string;
  flow_id?: string;
  memoryProvider?: MemoryProvider;
  timeoutMs?: number;
  root?: string;
}

export interface SendChatResult {
  ok: boolean;
  reply: string;
  exit_code: number | null;
  timedOut: boolean;
  transcript_path: string;
}

/**
 * Shell-like one-shot chat. Appends the user message to the transcript,
 * calls AgentBackend.run() with role="chat", appends the reply, returns.
 *
 * The backend prompt is bounded: flow snapshot, retrieved memory, recent
 * messages, and the latest user message. The full transcript stays on disk
 * but is never sent indefinitely.
 */
export async function sendChat(input: SendChatInput): Promise<SendChatResult> {
  const root = input.root ?? gflowRoot();
  const now = new Date().toISOString();
  const memory =
    input.memoryProvider ?? new LocalMemoryProvider(input.session_id, root);

  let transcript = await readTranscript(input.session_id, root);
  if (!transcript) {
    transcript = {
      session_id: input.session_id,
      backend: input.backend.name,
      created_at: now,
      messages: [],
    };
  }

  transcript.messages.push({
    role: "user",
    content: input.message,
    backend: input.backend.name,
    recorded_at: now,
  });
  await writeTranscript(transcript, root);

  const retrieved = await memory.retrieveContext({
    flow_id: input.flow_id,
    query: input.message,
    limit: 5,
  });
  const prompt = await buildChatPrompt({
    root,
    flow_id: input.flow_id,
    latestMessage: input.message,
    recent: transcript.messages.slice(-8),
    retrieved,
  });

  const result = await input.backend.run({
    role: "chat",
    prompt,
    cwd: input.cwd,
    timeoutMs: input.timeoutMs ?? CHAT_TIMEOUT_MS,
  });

  const reply = result.ok
    ? result.stdout
    : result.stderr ||
      `(no output; exit=${result.exitCode}, timedOut=${result.timedOut})`;

  transcript.messages.push({
    role: "assistant",
    content: reply,
    backend: input.backend.name,
    recorded_at: new Date().toISOString(),
    ok: result.ok,
    exit_code: result.exitCode,
  });
  await writeTranscript(transcript, root);
  await maybeWriteSummary({
    transcript,
    flow_id: input.flow_id,
    memory,
  });

  return {
    ok: result.ok,
    reply,
    exit_code: result.exitCode,
    timedOut: result.timedOut,
    transcript_path: chatPath(input.session_id, root),
  };
}

async function buildChatPrompt(input: {
  root: string;
  flow_id?: string;
  latestMessage: string;
  recent: ChatMessageT[];
  retrieved: RetrievedContext[];
}): Promise<string> {
  return [
    "# G_Flow Contextual Chat",
    "",
    "Answer the latest user message using the bounded context below. Do not assume unseen transcript messages are available.",
    "",
    "## Flow Snapshot",
    input.flow_id
      ? await flowSnapshotSummary(input.flow_id, input.root)
      : "(no flow_id attached)",
    "",
    "## Retrieved Memory",
    formatRetrieved(input.retrieved),
    "",
    "## Recent Messages",
    input.recent.map(formatMessage).join("\n\n") || "(none)",
    "",
    "## Latest User Message",
    input.latestMessage,
  ].join("\n");
}

async function flowSnapshotSummary(
  flowId: string,
  root: string,
): Promise<string> {
  try {
    const state = await readState(flowId, root);
    let contractSummary = "contract: not written";
    try {
      const contract = await readContractYaml(
        join(flowDir(flowId, root), "contract.yaml"),
      );
      const features = contract.milestones.reduce(
        (sum, m) => sum + m.features.length,
        0,
      );
      const assertions = contract.milestones.reduce(
        (sum, m) => sum + m.features.reduce((s, f) => s + f.assertions.length, 0),
        0,
      );
      contractSummary = `contract: ${contract.milestones.length} milestones, ${features} features, ${assertions} assertions`;
    } catch {
      // Contract is optional during clarification.
    }
    return [
      `flow_id: ${flowId}`,
      `phase: ${state.phase}`,
      `current_milestone: ${state.current_milestone ?? "(none)"}`,
      `current_feature: ${state.current_feature ?? "(none)"}`,
      `current_step: ${state.current_step ?? "(none)"}`,
      contractSummary,
    ].join("\n");
  } catch {
    return `(flow ${flowId} not found)`;
  }
}

function formatRetrieved(items: RetrievedContext[]): string {
  if (items.length === 0) return "(none)";
  return items
    .map(
      (item, idx) =>
        `${idx + 1}. ${item.title} [${item.source}, score=${item.score}]\n${item.body}`,
    )
    .join("\n\n");
}

function formatMessage(message: ChatMessageT): string {
  return `${message.role} (${message.recorded_at}):\n${message.content}`;
}

async function maybeWriteSummary(input: {
  transcript: ChatTranscriptT;
  flow_id?: string;
  memory: MemoryProvider;
}): Promise<void> {
  if (input.transcript.messages.length <= 8) return;
  const older = input.transcript.messages.slice(0, -8);
  const summary = older
    .map((message, idx) => `${idx + 1}. ${message.role}: ${truncate(message.content, 240)}`)
    .join("\n");
  await input.memory.writeSummary({
    session_id: input.transcript.session_id,
    flow_id: input.flow_id,
    summary,
    covered_message_ids: older.map((m, idx) => `${idx}:${m.recorded_at}`),
  });
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}...`;
}

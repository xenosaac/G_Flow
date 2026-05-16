import { mkdir, readFile, writeFile, rename, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { AgentBackend } from "../adapters/backend.ts";
import { gflowRoot } from "./state.ts";

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
      .filter((f) => f.endsWith(".json") && !f.includes(".tmp."))
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
 * NOTE: V1 does not feed prior history back into the prompt — the agent is
 * stateless across messages. The transcript exists for the human to read.
 */
export async function sendChat(input: SendChatInput): Promise<SendChatResult> {
  const root = input.root ?? gflowRoot();
  const now = new Date().toISOString();

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

  const result = await input.backend.run({
    role: "chat",
    prompt: input.message,
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

  return {
    ok: result.ok,
    reply,
    exit_code: result.exitCode,
    timedOut: result.timedOut,
    transcript_path: chatPath(input.session_id, root),
  };
}

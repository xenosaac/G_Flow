import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, rm, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  sendChat,
  newSessionId,
  readTranscript,
  listSessions,
  chatPath,
} from "../src/runtime/chat.ts";
import { MockBackend } from "../src/adapters/mock.ts";

let TMP: string;
let prevRoot: string | undefined;

beforeEach(async () => {
  TMP = join(
    tmpdir(),
    `gflow-chat-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  await mkdir(TMP, { recursive: true });
  prevRoot = process.env.GFLOW_ROOT;
  process.env.GFLOW_ROOT = TMP;
});

afterEach(async () => {
  if (prevRoot === undefined) delete process.env.GFLOW_ROOT;
  else process.env.GFLOW_ROOT = prevRoot;
  await rm(TMP, { recursive: true, force: true });
});

describe("newSessionId", () => {
  test("produces s_<iso>_<rand>", () => {
    const id = newSessionId(new Date("2026-05-16T11:00:00.000Z"));
    expect(id.startsWith("s_2026-05-16T11-00-00-000Z_")).toBe(true);
  });
});

describe("sendChat", () => {
  test("persists user + agent messages and returns the reply", async () => {
    const backend = new MockBackend(() => ({ stdout: "Hello, builder." }));
    const sid = "s_test_0001";
    const r = await sendChat({
      session_id: sid,
      backend,
      message: "hi",
      cwd: TMP,
      timeoutMs: 1000,
    });
    expect(r.ok).toBe(true);
    expect(r.reply).toBe("Hello, builder.");
    expect(r.transcript_path).toBe(chatPath(sid));

    const t = await readTranscript(sid);
    expect(t).not.toBeNull();
    expect(t!.messages).toHaveLength(2);
    expect(t!.messages[0]!.role).toBe("user");
    expect(t!.messages[0]!.content).toBe("hi");
    expect(t!.messages[0]!.backend).toBe("mock");
    expect(t!.messages[0]!.recorded_at).toBeTruthy();
    expect(t!.messages[1]!.role).toBe("assistant");
    expect(t!.messages[1]!.content).toBe("Hello, builder.");
    expect(t!.messages[1]!.backend).toBe("mock");
    expect(t!.messages[1]!.recorded_at).toBeTruthy();
    expect(t!.messages[1]!.ok).toBe(true);
    expect(t!.backend).toBe("mock");
  });

  test("appends to an existing session (n calls → 2n messages)", async () => {
    const backend = new MockBackend((_req, i) => ({
      stdout: `reply ${i + 1}`,
    }));
    const sid = "s_append_0001";
    await sendChat({ session_id: sid, backend, message: "first", cwd: TMP, timeoutMs: 1000 });
    await sendChat({ session_id: sid, backend, message: "second", cwd: TMP, timeoutMs: 1000 });
    await sendChat({ session_id: sid, backend, message: "third", cwd: TMP, timeoutMs: 1000 });
    const t = await readTranscript(sid);
    expect(t!.messages).toHaveLength(6);
    expect(t!.messages.map((m) => m.role)).toEqual([
      "user", "assistant", "user", "assistant", "user", "assistant",
    ]);
    expect(t!.messages[5]!.content).toBe("reply 3");
  });

  test("backend failure: ok=false, stderr → reply", async () => {
    const backend = new MockBackend(() => ({
      stdout: "",
      stderr: "claude: not authenticated",
      ok: false,
      exitCode: 1,
    }));
    const sid = "s_fail_0001";
    const r = await sendChat({
      session_id: sid,
      backend,
      message: "x",
      cwd: TMP,
      timeoutMs: 1000,
    });
    expect(r.ok).toBe(false);
    expect(r.reply).toBe("claude: not authenticated");
    expect(r.exit_code).toBe(1);
    const t = await readTranscript(sid);
    expect(t!.messages[1]!.ok).toBe(false);
    expect(t!.messages[1]!.exit_code).toBe(1);
  });

  test("backend.run called with role='chat'", async () => {
    const backend = new MockBackend(() => ({ stdout: "ok" }));
    await sendChat({
      session_id: "s_role_0001",
      backend,
      message: "x",
      cwd: TMP,
      timeoutMs: 1000,
    });
    expect(backend.calls[0]!.role).toBe("chat");
  });
});

describe("listSessions", () => {
  test("returns [] when no chat dir", async () => {
    const sessions = await listSessions();
    expect(sessions).toEqual([]);
  });

  test("lists transcripts sorted newest first", async () => {
    const backend = new MockBackend(() => ({ stdout: "ok" }));
    await sendChat({ session_id: "s_a", backend, message: "x", cwd: TMP, timeoutMs: 1000 });
    await sendChat({ session_id: "s_b", backend, message: "x", cwd: TMP, timeoutMs: 1000 });
    const sessions = await listSessions();
    expect(sessions).toContain("s_a");
    expect(sessions).toContain("s_b");
  });
});

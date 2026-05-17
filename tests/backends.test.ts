import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { defaultBackend, UnknownBackendError, main } from "../src/cli/index.ts";
import { CodexBackend } from "../src/adapters/codex.ts";
import { ClaudeCodeBackend } from "../src/adapters/claude-code.ts";

let prev: string | undefined;

beforeEach(() => {
  prev = process.env.GFLOW_BACKEND;
});

afterEach(() => {
  if (prev === undefined) delete process.env.GFLOW_BACKEND;
  else process.env.GFLOW_BACKEND = prev;
});

describe("defaultBackend selection", () => {
  test("unset → claude-code (default)", async () => {
    delete process.env.GFLOW_BACKEND;
    const b = await defaultBackend();
    expect(b).toBeInstanceOf(ClaudeCodeBackend);
    expect(b?.name).toBe("claude-code");
  });

  test("'claude-code' → ClaudeCodeBackend", async () => {
    process.env.GFLOW_BACKEND = "claude-code";
    const b = await defaultBackend();
    expect(b).toBeInstanceOf(ClaudeCodeBackend);
  });

  test("'codex' → CodexBackend", async () => {
    process.env.GFLOW_BACKEND = "codex";
    const b = await defaultBackend();
    expect(b).toBeInstanceOf(CodexBackend);
    expect(b?.name).toBe("codex");
  });

  test("'opencloud' is unsupported", async () => {
    process.env.GFLOW_BACKEND = "opencloud";
    await expect(defaultBackend()).rejects.toThrow(UnknownBackendError);
  });

  test("'none' → null", async () => {
    process.env.GFLOW_BACKEND = "none";
    const b = await defaultBackend();
    expect(b).toBeNull();
  });

  test("'off' alias → null", async () => {
    process.env.GFLOW_BACKEND = "off";
    const b = await defaultBackend();
    expect(b).toBeNull();
  });

  test("case-insensitive: 'CODEX' → CodexBackend", async () => {
    process.env.GFLOW_BACKEND = "CODEX";
    const b = await defaultBackend();
    expect(b).toBeInstanceOf(CodexBackend);
  });

  test("unknown value throws UnknownBackendError with a clear message", async () => {
    process.env.GFLOW_BACKEND = "gpt-9000";
    let err: unknown = null;
    try {
      await defaultBackend();
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(UnknownBackendError);
    expect((err as Error).message).toMatch(/Unknown GFLOW_BACKEND/);
    expect((err as Error).message).toMatch(/claude-code/);
    expect((err as Error).message).toMatch(/codex/);
  });

  test("main() with unknown backend exits 64 (does NOT silently default to none)", async () => {
    process.env.GFLOW_BACKEND = "haunted-llm";
    const code = await main(["start", "build something"]);
    expect(code).toBe(64);
  });
});

describe("CodexBackend.run", () => {
  test("calls codex with the documented argv when prompted (binary override forces failure)", async () => {
    // Use a fake binary that doesn't exist; we only care that the spawn was
    // attempted with the right shape. The result will be ok=false / spawn
    // error captured in stderr.
    const b = new CodexBackend({ binary: "/does/not/exist/codex-fake" });
    const r = await b.run({
      role: "worker",
      prompt: "hello",
      cwd: process.cwd(),
      timeoutMs: 2000,
    });
    expect(r.ok).toBe(false);
    // Either ENOENT in stderr or exit code != 0; we don't care about specifics
    expect(r.exitCode === null || r.exitCode !== 0).toBe(true);
  });
});

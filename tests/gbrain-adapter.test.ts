import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  selectAdapter,
  __setGbrainSpawn,
  __setGbrainFetch,
  GbrainToolError,
  GbrainProtocolError,
  GbrainAuthError,
} from "../src/gbrain/adapter.ts";
import { buildPlanCreated } from "../src/gbrain/snapshot.ts";
import { __resetOutboxCounters } from "../src/gbrain/outbox.ts";
import { __resetGbrainWarned } from "../src/gbrain/client.ts";
import type { SpawnOptions, SpawnResult } from "../src/adapters/spawn.ts";

let TMP: string;
let prevRoot: string | undefined;
let prevEnv: Record<string, string | undefined> = {};

const ENV_VARS = [
  "GBRAIN_MODE",
  "GBRAIN_BIN",
  "GBRAIN_HTTP_URL",
  "GBRAIN_AUTH_TOKEN",
  "GBRAIN_SOURCE_ID",
];

function setEnv(env: Record<string, string | undefined>) {
  for (const k of ENV_VARS) {
    prevEnv[k] = process.env[k];
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
}

function restoreEnv() {
  for (const k of ENV_VARS) {
    if (prevEnv[k] === undefined) delete process.env[k];
    else process.env[k] = prevEnv[k];
  }
  prevEnv = {};
}

const TINY_CONTRACT = {
  flow_id: "f_test",
  goal: "test",
  created_at: "2026-05-16T00:00:00Z",
  milestones: [
    {
      id: "M-001",
      title: "M",
      endpoint_criteria: "ok",
      features: [
        {
          id: "F-001",
          title: "F",
          spec: "spec",
          assertions: [
            {
              id: "A-001-001",
              text: "a",
              validator: "screwdriver" as const,
              evidence_required: "n/a",
              status: "pending" as const,
              origin: "original" as const,
              attempts: [],
              check: { kind: "file_exists" as const, path: "index.html" },
            },
          ],
        },
      ],
    },
  ],
};

beforeEach(async () => {
  TMP = join(
    tmpdir(),
    `gflow-adapter-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  await mkdir(join(TMP, "f_test"), { recursive: true });
  prevRoot = process.env.GFLOW_ROOT;
  process.env.GFLOW_ROOT = TMP;
  __resetGbrainWarned();
  __resetOutboxCounters();
});

afterEach(async () => {
  if (prevRoot === undefined) delete process.env.GFLOW_ROOT;
  else process.env.GFLOW_ROOT = prevRoot;
  restoreEnv();
  __setGbrainSpawn(undefined);
  __setGbrainFetch(undefined);
  await rm(TMP, { recursive: true, force: true });
});

describe("selectAdapter", () => {
  test("off mode is default", () => {
    setEnv({});
    const a = selectAdapter();
    expect(a.mode).toBe("off");
    expect(a.source_id).toBe("gflow");
  });

  test("unknown mode → ConfigErrorAdapter (does not throw)", () => {
    setEnv({ GBRAIN_MODE: "banana" });
    const a = selectAdapter();
    expect(a.mode).toBe("off");
  });

  test("mcp-http without URL+TOKEN → ConfigErrorAdapter", async () => {
    setEnv({ GBRAIN_MODE: "mcp-http" });
    const a = selectAdapter();
    const h = await a.health();
    expect(h.ok).toBe(false);
    expect(h.reason).toBe("misconfigured");
  });

  test("GBRAIN_SOURCE_ID picked up", () => {
    setEnv({ GBRAIN_SOURCE_ID: "myteam" });
    const a = selectAdapter();
    expect(a.source_id).toBe("myteam");
  });
});

describe("OffAdapter", () => {
  test("enqueue still writes JSONL", async () => {
    setEnv({});
    const a = selectAdapter();
    a.enqueueSnapshot(
      buildPlanCreated({
        flow_id: "f_test",
        source_id: "gflow",
        goal: "g",
        contract: TINY_CONTRACT,
      }),
    );
    await a.flush("f_test");
    const dir = join(TMP, "f_test", "gbrain-queue");
    const { readdir } = await import("node:fs/promises");
    const files = await readdir(dir);
    expect(files.length).toBe(1);
  });

  test("health ok, drain trivial-ok, query empty", async () => {
    setEnv({});
    const a = selectAdapter();
    expect((await a.health()).ok).toBe(true);
    const drain = await a.drainOutbox("f_test");
    expect(drain.ok).toBe(true);
    expect(drain.drained).toBe(0);
    const q = await a.queryContext("hi");
    expect(q.results.length).toBe(0);
  });
});

describe("LocalCliAdapter", () => {
  test("health: cli_not_found surfaces correctly", async () => {
    setEnv({ GBRAIN_MODE: "local-cli", GBRAIN_BIN: "/nonexistent/gbrain" });
    __setGbrainSpawn(
      async (argv: string[], _opts: SpawnOptions): Promise<SpawnResult> => ({
        ok: false,
        exitCode: null,
        stdout: "",
        stderr: "ENOENT: no such file or directory",
        timedOut: false,
      }),
    );
    const a = selectAdapter();
    const h = await a.health();
    expect(h.ok).toBe(false);
    expect(h.reason).toBe("cli_not_found");
  });

  test("queryContext spawns `gbrain call query '<json>'` with source env", async () => {
    setEnv({ GBRAIN_MODE: "local-cli", GBRAIN_SOURCE_ID: "team-a" });
    let capturedArgv: string[] = [];
    let capturedEnv: Record<string, string | undefined> | undefined;
    __setGbrainSpawn(
      async (argv: string[], opts: SpawnOptions): Promise<SpawnResult> => {
        capturedArgv = argv;
        capturedEnv = opts.env;
        return {
          ok: true,
          exitCode: 0,
          stdout: JSON.stringify([{ slug: "s/1", score: 0.9, text: "x" }]),
          stderr: "",
          timedOut: false,
        };
      },
    );
    const a = selectAdapter();
    const r = await a.queryContext("hello", { limit: 3 });
    expect(r.results.length).toBe(1);
    expect(r.results[0]!.slug).toBe("s/1");
    expect(capturedArgv).toEqual([
      "gbrain",
      "call",
      "query",
      JSON.stringify({ query: "hello", limit: 3, source_id: "team-a" }),
    ]);
    expect(capturedEnv?.GBRAIN_SOURCE).toBe("team-a");
  });

  test("drainOutbox calls `gbrain call put_page` with {slug, content} only", async () => {
    setEnv({ GBRAIN_MODE: "local-cli" });
    const a = selectAdapter();
    a.enqueueSnapshot(
      buildPlanCreated({
        flow_id: "f_test",
        source_id: "gflow",
        goal: "g",
        contract: TINY_CONTRACT,
      }),
    );
    await a.flush("f_test");
    let capturedArgs: object | null = null;
    __setGbrainSpawn(
      async (argv: string[]): Promise<SpawnResult> => {
        if (argv[1] === "call" && argv[2] === "put_page") {
          capturedArgs = JSON.parse(argv[3]!);
        }
        return { ok: true, exitCode: 0, stdout: "{}", stderr: "", timedOut: false };
      },
    );
    const r = await a.drainOutbox("f_test");
    expect(r.synced).toBe(1);
    expect(r.failed).toBe(0);
    expect(capturedArgs).toBeTruthy();
    const argsObj = capturedArgs as unknown as Record<string, unknown>;
    const keys = Object.keys(argsObj).sort();
    expect(keys).toEqual(["content", "slug"]);
    // No "source" or "source_id" leaked into put_page args.
    expect(argsObj.source).toBeUndefined();
    expect(argsObj.source_id).toBeUndefined();
  });
});

describe("McpHttpAdapter", () => {
  function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
    return new Response(JSON.stringify(body), {
      status: init.status ?? 200,
      headers: { "content-type": "application/json", ...(init.headers ?? {}) },
    });
  }

  test("ToolResult unpacks isError=false correctly", async () => {
    setEnv({
      GBRAIN_MODE: "mcp-http",
      GBRAIN_HTTP_URL: "http://example.test",
      GBRAIN_AUTH_TOKEN: "tok",
    });
    __setGbrainFetch(async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/health")) return jsonResponse({ ok: true });
      return jsonResponse({
        jsonrpc: "2.0",
        id: "x",
        result: {
          isError: false,
          content: [{ type: "text", text: JSON.stringify([{ slug: "a/b", score: 0.7, text: "t" }]) }],
        },
      });
    });
    const a = selectAdapter();
    const r = await a.queryContext("q", { limit: 1 });
    expect(r.results[0]!.slug).toBe("a/b");
  });

  test("ToolResult with isError=true throws GbrainToolError", async () => {
    setEnv({
      GBRAIN_MODE: "mcp-http",
      GBRAIN_HTTP_URL: "http://example.test",
      GBRAIN_AUTH_TOKEN: "tok",
    });
    __setGbrainFetch(async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/health")) return jsonResponse({ ok: true });
      return jsonResponse({
        jsonrpc: "2.0",
        id: "x",
        result: {
          isError: true,
          content: [{ type: "text", text: "validation failed: slug required" }],
        },
      });
    });
    // Enqueue + try drain so we hit put_page → which will throw → drain reports failed.
    const a = selectAdapter();
    a.enqueueSnapshot(
      buildPlanCreated({
        flow_id: "f_test",
        source_id: "gflow",
        goal: "g",
        contract: TINY_CONTRACT,
      }),
    );
    await a.flush("f_test");
    const r = await a.drainOutbox("f_test");
    expect(r.ok).toBe(false);
    expect(r.failed).toBe(1);
    expect(r.errors[0]?.message).toContain("validation failed");
  });

  test("Missing content[0].text → GbrainProtocolError surfaces in drain", async () => {
    setEnv({
      GBRAIN_MODE: "mcp-http",
      GBRAIN_HTTP_URL: "http://example.test",
      GBRAIN_AUTH_TOKEN: "tok",
    });
    __setGbrainFetch(async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/health")) return jsonResponse({ ok: true });
      return jsonResponse({
        jsonrpc: "2.0",
        id: "x",
        result: { isError: false, content: [] }, // missing text
      });
    });
    const a = selectAdapter();
    a.enqueueSnapshot(
      buildPlanCreated({
        flow_id: "f_test",
        source_id: "gflow",
        goal: "g",
        contract: TINY_CONTRACT,
      }),
    );
    await a.flush("f_test");
    const r = await a.drainOutbox("f_test");
    expect(r.ok).toBe(false);
    expect(r.errors[0]?.message.toLowerCase()).toContain("content[0].text");
  });

  test("Non-JSON content[0].text → GbrainProtocolError", async () => {
    setEnv({
      GBRAIN_MODE: "mcp-http",
      GBRAIN_HTTP_URL: "http://example.test",
      GBRAIN_AUTH_TOKEN: "tok",
    });
    __setGbrainFetch(async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/health")) return jsonResponse({ ok: true });
      return jsonResponse({
        jsonrpc: "2.0",
        id: "x",
        result: { isError: false, content: [{ type: "text", text: "not-json-at-all" }] },
      });
    });
    const a = selectAdapter();
    a.enqueueSnapshot(
      buildPlanCreated({
        flow_id: "f_test",
        source_id: "gflow",
        goal: "g",
        contract: TINY_CONTRACT,
      }),
    );
    await a.flush("f_test");
    const r = await a.drainOutbox("f_test");
    expect(r.ok).toBe(false);
    expect(r.errors[0]?.message.toLowerCase()).toContain("non-json");
  });

  test("put_page request body has only {slug, content}, bearer header set", async () => {
    setEnv({
      GBRAIN_MODE: "mcp-http",
      GBRAIN_HTTP_URL: "http://example.test",
      GBRAIN_AUTH_TOKEN: "secret-token",
    });
    const captured: {
      body: { method?: string; params?: { name?: string; arguments?: Record<string, unknown> } } | null;
      auth: string | null;
    } = { body: null, auth: null };
    __setGbrainFetch(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/health")) return jsonResponse({ ok: true });
      if (init?.body) {
        captured.body = JSON.parse(init.body as string);
        const h = init.headers as Record<string, string> | undefined;
        captured.auth = h?.authorization ?? null;
      }
      return jsonResponse({
        jsonrpc: "2.0",
        id: "x",
        result: { isError: false, content: [{ type: "text", text: "{}" }] },
      });
    });
    const a = selectAdapter();
    a.enqueueSnapshot(
      buildPlanCreated({
        flow_id: "f_test",
        source_id: "gflow",
        goal: "g",
        contract: TINY_CONTRACT,
      }),
    );
    await a.flush("f_test");
    await a.drainOutbox("f_test");

    expect(captured.auth).toBe("Bearer secret-token");
    expect(captured.body?.method).toBe("tools/call");
    expect(captured.body?.params?.name).toBe("put_page");
    const args = captured.body?.params?.arguments;
    expect(Object.keys(args ?? {}).sort()).toEqual(["content", "slug"]);
  });

  test("Token never appears in error messages", async () => {
    setEnv({
      GBRAIN_MODE: "mcp-http",
      GBRAIN_HTTP_URL: "http://example.test",
      GBRAIN_AUTH_TOKEN: "supersecret-XYZ",
    });
    __setGbrainFetch(async (): Promise<Response> => {
      throw new Error("connection refused (token=supersecret-XYZ visible in error)");
    });
    const a = selectAdapter();
    const h = await a.health();
    expect(h.ok).toBe(false);
    expect(JSON.stringify(h)).not.toContain("supersecret-XYZ");
  });

  test("401 → auth_failed health", async () => {
    setEnv({
      GBRAIN_MODE: "mcp-http",
      GBRAIN_HTTP_URL: "http://example.test",
      GBRAIN_AUTH_TOKEN: "tok",
    });
    __setGbrainFetch(async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/health")) return jsonResponse({ ok: true });
      return jsonResponse({ error: "unauthorized" }, { status: 401 });
    });
    const a = selectAdapter();
    const h = await a.health();
    expect(h.ok).toBe(false);
    expect(h.reason).toBe("auth_failed");
  });
});

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { spawnPiped, type SpawnOptions, type SpawnResult } from "../adapters/spawn.ts";
import { flowDir, gflowRoot, latestFlow } from "../runtime/state.ts";
import { appendToOutbox } from "./client.ts";
import {
  enumerateOutbox,
  outboxDir,
  acquireDrainLock,
  releaseDrainLock,
  renameToSynced,
  renameToFailed,
  retryReset,
  renameToLegacyConsumed,
  readLastDrain as readLastDrainFile,
  writeLastDrain as writeLastDrainFile,
} from "./outbox.ts";
import { renderPage } from "./page.ts";
import {
  GbrainSnapshotV2,
  type GbrainSnapshotV2T,
} from "./snapshot.ts";

export type GbrainMode = "off" | "local-cli" | "mcp-http";

export const SUPPORTED_MODES: GbrainMode[] = ["off", "local-cli", "mcp-http"];

export type GbrainHealthReason =
  | "ok"
  | "cli_not_found"
  | "cli_broken"
  | "doctor_failed"
  | "http_unreachable"
  | "auth_failed"
  | "rate_limited"
  | "incompatible_server"
  | "misconfigured"
  | "unknown_mode";

export interface GbrainHealth {
  mode: GbrainMode;
  ok: boolean;
  reason: GbrainHealthReason;
  detail?: string;
  warnings: string[];
  source_id: string;
  checked_at: string;
}

export interface DrainResult {
  ok: boolean;
  drained: number;
  synced: number;
  failed: number;
  errors: { file: string; message: string }[];
  started_at: string;
  finished_at: string;
}

export interface QueryResult {
  slug: string;
  score: number;
  text: string;
  source?: string;
}

export interface RetrievedContext {
  results: QueryResult[];
  truncated: boolean;
  query_ms: number;
}

export interface GbrainAdapter {
  mode: GbrainMode;
  source_id: string;
  enqueueSnapshot(snapshot: GbrainSnapshotV2T): void;
  flush(flow_id?: string): Promise<void>;
  health(): Promise<GbrainHealth>;
  queryContext(q: string, opts?: { limit?: number; timeout_ms?: number }): Promise<RetrievedContext>;
  drainOutbox(flow_id?: string): Promise<DrainResult>;
}

// ----- Errors -----

export class GbrainCliError extends Error {
  constructor(public readonly stderr: string, public readonly exitCode: number | null) {
    super(`gbrain CLI failed (exit ${exitCode}): ${truncate(stderr, 600)}`);
    this.name = "GbrainCliError";
  }
}
export class GbrainAuthError extends Error {
  constructor(detail: string) {
    super(`GBrain auth failed: ${detail}`);
    this.name = "GbrainAuthError";
  }
}
export class GbrainHttpError extends Error {
  constructor(public readonly status: number, body: string) {
    super(`GBrain HTTP ${status}: ${truncate(body, 600)}`);
    this.name = "GbrainHttpError";
  }
}
export class GbrainRateLimitError extends Error {
  constructor(public readonly retryAfter: string | null) {
    super(`GBrain rate-limited; retry-after=${retryAfter ?? "?"}`);
    this.name = "GbrainRateLimitError";
  }
}
export class GbrainRpcError extends Error {
  constructor(public readonly code: number | string, msg: string) {
    super(`GBrain JSON-RPC error (${code}): ${msg}`);
    this.name = "GbrainRpcError";
  }
}
export class GbrainToolError extends Error {
  constructor(public readonly tool: string, msg: string) {
    super(`GBrain tool '${tool}' returned isError: ${truncate(msg, 600)}`);
    this.name = "GbrainToolError";
  }
}
export class GbrainProtocolError extends Error {
  constructor(msg: string) {
    super(`GBrain protocol error: ${msg}`);
    this.name = "GbrainProtocolError";
  }
}

// ----- Test seams -----

type SpawnFn = (argv: string[], opts: SpawnOptions) => Promise<SpawnResult>;
type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

let _spawn: SpawnFn = spawnPiped;
let _fetch: FetchFn = (input, init) => fetch(input, init);

export function __setGbrainSpawn(fn?: SpawnFn): void {
  _spawn = fn ?? spawnPiped;
}
export function __setGbrainFetch(fn?: FetchFn): void {
  _fetch = fn ?? ((input, init) => fetch(input, init));
}

// ----- selectAdapter -----

export function selectAdapter(env: NodeJS.ProcessEnv = process.env): GbrainAdapter {
  const rawMode = (env.GBRAIN_MODE ?? "").trim().toLowerCase();
  const source_id = (env.GBRAIN_SOURCE_ID ?? "").trim() || "gflow";

  if (rawMode === "" || rawMode === "off") {
    return new OffAdapter(source_id);
  }
  if (rawMode === "local-cli") {
    const bin = (env.GBRAIN_BIN ?? "gbrain").trim() || "gbrain";
    return new LocalCliAdapter({ bin, source_id });
  }
  if (rawMode === "mcp-http") {
    const url = (env.GBRAIN_HTTP_URL ?? "").trim();
    const token = (env.GBRAIN_AUTH_TOKEN ?? "").trim();
    const timeoutMs = Number(env.GBRAIN_HTTP_TIMEOUT_MS ?? "10000") || 10000;
    if (!url || !token) {
      return new ConfigErrorAdapter(
        "mcp-http",
        source_id,
        "misconfigured",
        "GBRAIN_MODE=mcp-http requires both GBRAIN_HTTP_URL and GBRAIN_AUTH_TOKEN",
      );
    }
    return new McpHttpAdapter({ url, token, source_id, timeoutMs });
  }
  return new ConfigErrorAdapter(
    "off",
    source_id,
    "unknown_mode",
    `Unknown GBRAIN_MODE=${rawMode}. Allowed: ${SUPPORTED_MODES.join(" | ")}.`,
  );
}

// ----- OffAdapter -----

class OffAdapter implements GbrainAdapter {
  mode: GbrainMode = "off";
  constructor(public source_id: string) {}

  enqueueSnapshot(snapshot: GbrainSnapshotV2T): void {
    appendToOutbox(snapshot);
  }
  async flush(flow_id?: string): Promise<void> {
    const { flushGbrain } = await import("./client.ts");
    await flushGbrain(flow_id);
  }
  async health(): Promise<GbrainHealth> {
    return {
      mode: "off",
      ok: true,
      reason: "ok",
      detail: "GBrain integration is disabled. Set GBRAIN_MODE=local-cli or mcp-http to enable.",
      warnings: [],
      source_id: this.source_id,
      checked_at: new Date().toISOString(),
    };
  }
  async queryContext(): Promise<RetrievedContext> {
    return { results: [], truncated: false, query_ms: 0 };
  }
  async drainOutbox(): Promise<DrainResult> {
    const now = new Date().toISOString();
    return {
      ok: true,
      drained: 0,
      synced: 0,
      failed: 0,
      errors: [],
      started_at: now,
      finished_at: now,
    };
  }
}

// ----- ConfigErrorAdapter -----

class ConfigErrorAdapter implements GbrainAdapter {
  constructor(
    public mode: GbrainMode,
    public source_id: string,
    private reason: GbrainHealthReason,
    private detail: string,
  ) {}

  enqueueSnapshot(snapshot: GbrainSnapshotV2T): void {
    // Runtime hot path stays alive — JSONL outbox still works.
    appendToOutbox(snapshot);
  }
  async flush(flow_id?: string): Promise<void> {
    const { flushGbrain } = await import("./client.ts");
    await flushGbrain(flow_id);
  }
  async health(): Promise<GbrainHealth> {
    return {
      mode: this.mode,
      ok: false,
      reason: this.reason,
      detail: this.detail,
      warnings: [],
      source_id: this.source_id,
      checked_at: new Date().toISOString(),
    };
  }
  async queryContext(): Promise<RetrievedContext> {
    // Silent-empty for the retrieval hot path.
    return { results: [], truncated: false, query_ms: 0 };
  }
  async drainOutbox(): Promise<DrainResult> {
    // Explicit user action → structured ok:false, not silent success.
    const now = new Date().toISOString();
    return {
      ok: false,
      drained: 0,
      synced: 0,
      failed: 0,
      errors: [{ file: "—", message: `GBrain misconfigured: ${this.detail}` }],
      started_at: now,
      finished_at: now,
    };
  }
}

// ----- LocalCliAdapter -----

interface LocalCliConfig {
  bin: string;
  source_id: string;
}

class LocalCliAdapter implements GbrainAdapter {
  mode: GbrainMode = "local-cli";
  source_id: string;
  private bin: string;

  constructor(cfg: LocalCliConfig) {
    this.bin = cfg.bin;
    this.source_id = cfg.source_id;
  }

  enqueueSnapshot(snapshot: GbrainSnapshotV2T): void {
    appendToOutbox(snapshot);
  }
  async flush(flow_id?: string): Promise<void> {
    const { flushGbrain } = await import("./client.ts");
    await flushGbrain(flow_id);
  }

  async health(): Promise<GbrainHealth> {
    const warnings: string[] = [];
    const checked_at = new Date().toISOString();
    // Step 1: --version
    const ver = await this.runGbrain(["--version"], { timeoutMs: 5000 });
    if (ver.exitCode === null && (ver.stderr.includes("ENOENT") || ver.stderr.includes("not found") || ver.stderr.includes("no such"))) {
      return {
        mode: "local-cli",
        ok: false,
        reason: "cli_not_found",
        detail: `gbrain binary not found at '${this.bin}' (${truncate(ver.stderr, 200)})`,
        warnings,
        source_id: this.source_id,
        checked_at,
      };
    }
    if (!ver.ok) {
      return {
        mode: "local-cli",
        ok: false,
        reason: "cli_broken",
        detail: `gbrain --version exited ${ver.exitCode}: ${truncate(ver.stderr, 200)}`,
        warnings,
        source_id: this.source_id,
        checked_at,
      };
    }
    // Step 2: doctor --json --fast
    const doc = await this.runGbrain(["doctor", "--json", "--fast"], { timeoutMs: 10000 });
    if (!doc.ok) {
      return {
        mode: "local-cli",
        ok: false,
        reason: "doctor_failed",
        detail: `gbrain doctor exited ${doc.exitCode}: ${truncate(doc.stderr, 200)}`,
        warnings,
        source_id: this.source_id,
        checked_at,
      };
    }
    return {
      mode: "local-cli",
      ok: true,
      reason: "ok",
      detail: `gbrain ${ver.stdout.trim()}`,
      warnings,
      source_id: this.source_id,
      checked_at,
    };
  }

  async queryContext(q: string, opts?: { limit?: number; timeout_ms?: number }): Promise<RetrievedContext> {
    const limit = opts?.limit ?? 5;
    const timeoutMs = opts?.timeout_ms ?? 8000;
    const args = ["call", "query", JSON.stringify({ query: q, limit, source_id: this.source_id })];
    const t0 = Date.now();
    const r = await this.runGbrain(args, { timeoutMs });
    const query_ms = Date.now() - t0;
    if (!r.ok) {
      // Silent-empty + warn — never break the calling agent loop.
      console.warn(`gbrain: queryContext failed (${r.exitCode}): ${truncate(r.stderr, 200)}`);
      return { results: [], truncated: false, query_ms };
    }
    try {
      const parsed = JSON.parse(r.stdout);
      const results = parseQueryResults(parsed);
      return { results: results.slice(0, limit), truncated: results.length > limit, query_ms };
    } catch (err) {
      console.warn(`gbrain: queryContext returned non-JSON stdout`);
      return { results: [], truncated: false, query_ms };
    }
  }

  async drainOutbox(flow_id?: string): Promise<DrainResult> {
    return runDrain(this, flow_id, (page) => this.putPage(page));
  }

  private async putPage(page: { slug: string; content: string }): Promise<void> {
    const args = ["call", "put_page", JSON.stringify({ slug: page.slug, content: page.content })];
    const r = await this.runGbrain(args, { timeoutMs: 30000 });
    if (!r.ok) throw new GbrainCliError(r.stderr, r.exitCode);
  }

  private runGbrain(args: string[], opts: { timeoutMs: number }): Promise<SpawnResult> {
    const env: Record<string, string | undefined> = { ...process.env, GBRAIN_SOURCE: this.source_id };
    return _spawn([this.bin, ...args], {
      cwd: process.cwd(),
      env,
      timeoutMs: opts.timeoutMs,
    });
  }
}

// ----- McpHttpAdapter -----

interface McpHttpConfig {
  url: string;
  token: string;
  source_id: string;
  timeoutMs: number;
}

class McpHttpAdapter implements GbrainAdapter {
  mode: GbrainMode = "mcp-http";
  source_id: string;
  private url: string;
  private token: string;
  private timeoutMs: number;

  constructor(cfg: McpHttpConfig) {
    this.url = cfg.url.replace(/\/+$/, "");
    this.token = cfg.token;
    this.source_id = cfg.source_id;
    this.timeoutMs = cfg.timeoutMs;
  }

  enqueueSnapshot(snapshot: GbrainSnapshotV2T): void {
    appendToOutbox(snapshot);
  }
  async flush(flow_id?: string): Promise<void> {
    const { flushGbrain } = await import("./client.ts");
    await flushGbrain(flow_id);
  }

  async health(): Promise<GbrainHealth> {
    const warnings: string[] = [];
    const checked_at = new Date().toISOString();

    // Optional source warning — put_page accepts no source field.
    if ((process.env.GBRAIN_SOURCE_ID ?? "").trim() && this.source_id !== "gflow") {
      warnings.push(
        "source_unscoped_writes: GBRAIN_SOURCE_ID is set but put_page accepts no source field; writes land under the auth token's default scope. " +
          "Register a source-scoped client with 'gbrain auth register-client <name> --scopes \"read write\"' for source-restricted writes.",
      );
    }

    // Step 1: GET /health (no auth)
    try {
      const r = await _fetch(`${this.url}/health`, {
        method: "GET",
        signal: AbortSignal.timeout(3000),
      });
      if (!r.ok && r.status !== 404) {
        return {
          mode: "mcp-http",
          ok: false,
          reason: "http_unreachable",
          detail: `/health returned ${r.status}`,
          warnings,
          source_id: this.source_id,
          checked_at,
        };
      }
    } catch (err) {
      return {
        mode: "mcp-http",
        ok: false,
        reason: "http_unreachable",
        detail: redactToken(stringifyErr(err), this.token),
        warnings,
        source_id: this.source_id,
        checked_at,
      };
    }

    // Step 2: POST /mcp tools/list with bearer
    let toolsList: { name: string }[];
    try {
      const result = await this.rpc("tools/list", {}, 5000);
      const list = (result as { tools?: { name: string }[] }).tools;
      if (!Array.isArray(list)) {
        return {
          mode: "mcp-http",
          ok: false,
          reason: "incompatible_server",
          detail: `tools/list response missing tools[] array`,
          warnings,
          source_id: this.source_id,
          checked_at,
        };
      }
      toolsList = list;
    } catch (err) {
      if (err instanceof GbrainAuthError) {
        return {
          mode: "mcp-http",
          ok: false,
          reason: "auth_failed",
          detail: redactToken(err.message, this.token),
          warnings,
          source_id: this.source_id,
          checked_at,
        };
      }
      if (err instanceof GbrainRateLimitError) {
        return {
          mode: "mcp-http",
          ok: false,
          reason: "rate_limited",
          detail: `retry after ${err.retryAfter ?? "?"}`,
          warnings,
          source_id: this.source_id,
          checked_at,
        };
      }
      return {
        mode: "mcp-http",
        ok: false,
        reason: "http_unreachable",
        detail: redactToken(stringifyErr(err), this.token),
        warnings,
        source_id: this.source_id,
        checked_at,
      };
    }

    const required = ["put_page", "query"];
    const missing = required.filter((r) => !toolsList.some((t) => t.name === r));
    if (missing.length > 0) {
      return {
        mode: "mcp-http",
        ok: false,
        reason: "incompatible_server",
        detail: `Required tools missing on server: ${missing.join(", ")}`,
        warnings,
        source_id: this.source_id,
        checked_at,
      };
    }

    return {
      mode: "mcp-http",
      ok: true,
      reason: "ok",
      detail: `tools/list returned ${toolsList.length} tools`,
      warnings,
      source_id: this.source_id,
      checked_at,
    };
  }

  async queryContext(q: string, opts?: { limit?: number; timeout_ms?: number }): Promise<RetrievedContext> {
    const limit = opts?.limit ?? 5;
    const timeoutMs = opts?.timeout_ms ?? this.timeoutMs;
    const t0 = Date.now();
    try {
      const args: Record<string, unknown> = { query: q, limit };
      if (this.source_id) args.source_id = this.source_id;
      const out = await this.callTool<unknown>("query", args, timeoutMs);
      const results = parseQueryResults(out);
      return {
        results: results.slice(0, limit),
        truncated: results.length > limit,
        query_ms: Date.now() - t0,
      };
    } catch (err) {
      console.warn(`gbrain: queryContext failed: ${redactToken(stringifyErr(err), this.token)}`);
      return { results: [], truncated: false, query_ms: Date.now() - t0 };
    }
  }

  async drainOutbox(flow_id?: string): Promise<DrainResult> {
    return runDrain(this, flow_id, (page) => this.putPage(page));
  }

  private async putPage(page: { slug: string; content: string }): Promise<void> {
    await this.callTool("put_page", { slug: page.slug, content: page.content }, this.timeoutMs);
  }

  private async rpc(method: string, params: object, timeoutMs: number): Promise<unknown> {
    const id = randomUUID();
    let res: Response;
    try {
      res = await _fetch(`${this.url}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.token}`,
        },
        body: JSON.stringify({ method, params, id }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new GbrainHttpError(0, redactToken(stringifyErr(err), this.token));
    }
    if (res.status === 401) {
      throw new GbrainAuthError("invalid or revoked bearer token");
    }
    if (res.status === 429) {
      throw new GbrainRateLimitError(res.headers.get("retry-after"));
    }
    if (!res.ok) {
      const body = await safeText(res);
      throw new GbrainHttpError(res.status, redactToken(body, this.token));
    }
    let body: { result?: unknown; error?: { code?: number | string; message?: string } };
    try {
      body = await res.json();
    } catch (err) {
      throw new GbrainProtocolError(`/mcp returned non-JSON body`);
    }
    if (body.error) {
      throw new GbrainRpcError(body.error.code ?? "unknown", body.error.message ?? "no message");
    }
    if (body.result === undefined || body.result === null) {
      throw new GbrainProtocolError(`/mcp missing 'result' field`);
    }
    return body.result;
  }

  private async callTool<T>(name: string, args: object, timeoutMs: number): Promise<T> {
    const result = await this.rpc("tools/call", { name, arguments: args }, timeoutMs);
    const r = result as {
      isError?: boolean;
      content?: { type?: string; text?: string }[];
    };
    if (r.isError) {
      const errText = r.content?.[0]?.text ?? "(no error text)";
      throw new GbrainToolError(name, errText);
    }
    const text = r.content?.[0]?.text;
    if (typeof text !== "string") {
      throw new GbrainProtocolError(`tools/call(${name}): missing content[0].text`);
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new GbrainProtocolError(`tools/call(${name}): non-JSON content[0].text`);
    }
  }
}

// ----- Shared drain pipeline -----

async function runDrain(
  adapter: GbrainAdapter,
  flow_id_arg: string | undefined,
  putPageFn: (page: { slug: string; content: string }) => Promise<void>,
): Promise<DrainResult> {
  const flow_id = flow_id_arg ?? (await latestFlow())?.flow_id;
  const started_at = new Date().toISOString();
  if (!flow_id) {
    const finished_at = new Date().toISOString();
    return { ok: true, drained: 0, synced: 0, failed: 0, errors: [], started_at, finished_at };
  }

  if (!(await acquireDrainLock(flow_id))) {
    const finished_at = new Date().toISOString();
    return {
      ok: false,
      drained: 0,
      synced: 0,
      failed: 0,
      errors: [{ file: "—", message: "drain already in progress" }],
      started_at,
      finished_at,
    };
  }

  let drained = 0;
  let synced = 0;
  let failed = 0;
  const errors: { file: string; message: string }[] = [];

  try {
    // Step 1: split legacy multi-line files. Preserve every raw non-empty line.
    await splitLegacyMultiline(flow_id);

    // Step 2: enumerate queued + previously-failed.
    const candidates = [
      ...(await enumerateOutbox(flow_id, { includeFailed: false })),
      ...(await enumerateOutbox(flow_id, { includeFailed: true })).filter((f) => f.state === "failed"),
    ];

    // Step 3: per-file attempt.
    for (const f of candidates.sort((a, b) => a.name.localeCompare(b.name))) {
      const target = f.state === "failed" ? await retryReset(f.path) : f.path;
      let raw: string;
      try {
        raw = await readFile(target, "utf8");
      } catch (err) {
        errors.push({ file: f.name, message: `read error: ${stringifyErr(err)}` });
        try {
          await renameToFailed(target, `read error: ${stringifyErr(err)}`);
        } catch {
          // best-effort
        }
        failed++;
        drained++;
        continue;
      }
      const firstLine = raw.split(/\r?\n/).find((l) => l.length > 0) ?? "";
      let snapshot: GbrainSnapshotV2T;
      try {
        const obj = JSON.parse(firstLine);
        snapshot = GbrainSnapshotV2.parse(obj);
      } catch (err) {
        await renameToFailed(target, `parse error: ${stringifyErr(err)}`);
        errors.push({ file: f.name, message: `parse error: ${truncate(stringifyErr(err), 200)}` });
        failed++;
        drained++;
        continue;
      }
      const page = renderPage(snapshot);
      try {
        await putPageFn(page);
        await renameToSynced(target);
        synced++;
      } catch (err) {
        const msg = stringifyErr(err);
        await renameToFailed(target, msg);
        errors.push({ file: f.name, message: truncate(msg, 200) });
        failed++;
      }
      drained++;
    }
  } finally {
    await releaseDrainLock(flow_id);
  }

  const finished_at = new Date().toISOString();
  const result: DrainResult = {
    ok: failed === 0,
    drained,
    synced,
    failed,
    errors,
    started_at,
    finished_at,
  };
  try {
    await writeLastDrainFile(flow_id, result);
  } catch {
    // best-effort
  }
  return result;
}

async function splitLegacyMultiline(flow_id: string): Promise<void> {
  const queued = await enumerateOutbox(flow_id, { includeFailed: false });
  for (const f of queued) {
    let raw: string;
    try {
      raw = await readFile(f.path, "utf8");
    } catch {
      continue;
    }
    const nonEmpty = raw.split(/\r?\n/).filter((l) => l.length > 0);
    if (nonEmpty.length <= 1) continue;
    const dir = outboxDir(flow_id);
    await mkdir(dir, { recursive: true });
    for (let i = 0; i < nonEmpty.length; i++) {
      const childName = `${f.name}.split.${String(i + 1).padStart(3, "0")}.jsonl`;
      const childPath = join(dir, childName);
      await writeFile(childPath, nonEmpty[i]! + "\n", "utf8");
    }
    await renameToLegacyConsumed(f.path);
  }
}

// ----- Helpers -----

function parseQueryResults(out: unknown): QueryResult[] {
  if (Array.isArray(out)) {
    return out
      .map(coerceResult)
      .filter((r): r is QueryResult => r !== null);
  }
  if (out && typeof out === "object") {
    const inner = (out as Record<string, unknown>).results;
    if (Array.isArray(inner)) {
      return inner.map(coerceResult).filter((r): r is QueryResult => r !== null);
    }
    const inner2 = (out as Record<string, unknown>).hits;
    if (Array.isArray(inner2)) {
      return inner2.map(coerceResult).filter((r): r is QueryResult => r !== null);
    }
  }
  return [];
}

function coerceResult(r: unknown): QueryResult | null {
  if (!r || typeof r !== "object") return null;
  const o = r as Record<string, unknown>;
  const slug = typeof o.slug === "string" ? o.slug : typeof o.id === "string" ? o.id : null;
  if (!slug) return null;
  const score = typeof o.score === "number" ? o.score : 0;
  const text = typeof o.text === "string"
    ? o.text
    : typeof o.snippet === "string"
      ? o.snippet
      : typeof o.body === "string"
        ? o.body
        : "";
  const source = typeof o.source === "string" ? o.source : undefined;
  return { slug, score, text, source };
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
}

function stringifyErr(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function redactToken(s: string, token: string): string {
  if (!token) return s;
  return s.split(token).join("[REDACTED]");
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "(unreadable body)";
  }
}

export async function readLastDrain(flow_id: string, root?: string): Promise<DrainResult | null> {
  const raw = await readLastDrainFile(flow_id, root);
  return raw as DrainResult | null;
}

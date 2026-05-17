import type { GbrainAdapter, QueryResult } from "./adapter.ts";

export interface RetrievedBlock {
  /** Markdown-safe block to splice into a prompt template. Always non-empty. */
  block: string;
  /** Slugs that contributed to the block, in order. */
  citations: string[];
}

export interface RetrieveContextOptions {
  role: "planner" | "worker" | "steward_triage" | "steward_encode";
  query: string;
  limit?: number;
  timeout_ms?: number;
}

const EMPTY_BLOCK = "<gbrain-memory-empty />";

const MAX_PER_LINE_CHARS = 200;
const MAX_PER_RESULT_CHARS = 800;
const MAX_TOTAL_CHARS = 4000;
const ROLE_MARKER_DENSITY_THRESHOLD = 0.1;

/**
 * Adversarial content patterns we strip when they appear at the start of a
 * line. Mid-line text is left alone so we don't corrupt legitimate content.
 * Defense-in-depth — the prompt template ALSO instructs the LLM to treat
 * content inside `<gbrain-memory>` tags as untrusted data.
 */
const ROLE_MARKERS = [
  /^\s*###\s*(?:system|assistant|user)\b.*$/i,
  /^\s*<\|im_start\|>.*$/,
  /^\s*<\|im_end\|>.*$/,
  /^\s*<\/?\s*(?:system|assistant|user)\s*>.*$/i,
  /^\s*(?:Assistant|Human|System|User)\s*:.*$/,
  /^\s*BEGIN\s+SYSTEM\s+PROMPT.*$/i,
  /^\s*END\s+SYSTEM\s+PROMPT.*$/i,
];

/**
 * Retrieve top-K context from GBrain for the given role and query.
 *
 * Returns a sanitized, structurally-framed markdown block that's safe to splice
 * into an LLM prompt template via `{{gbrain_context}}`. On any adapter error,
 * config error, timeout, or `GFLOW_GBRAIN_RETRIEVAL=off`, returns the empty
 * sentinel block without throwing.
 *
 * Defense-in-depth against prompt injection:
 * 1. Adapter `mode === "off"` short-circuits to empty.
 * 2. `GFLOW_GBRAIN_RETRIEVAL=off` short-circuits to empty.
 * 3. Each result is sanitized:
 *    - Strip ASCII control chars (keep `\n` `\t`).
 *    - Strip line-start role markers (`### system`, `<|im_start|>`, etc.).
 *    - Escape `{{` and `}}` to prevent template re-substitution.
 *    - Cap per-line at 200 chars, per-result at 800 chars.
 *    - Reject results with >0.1 markers/line ratio (suspicious injection blob).
 * 4. Each result is wrapped in `<gbrain-memory>` XML tags + blockquote prefix
 *    so the LLM sees it as data, not instructions.
 * 5. Total block capped at 4 KB.
 */
export async function retrieveContext(
  adapter: GbrainAdapter,
  opts: RetrieveContextOptions,
): Promise<RetrievedBlock> {
  if (process.env.GFLOW_GBRAIN_RETRIEVAL === "off") {
    return { block: EMPTY_BLOCK, citations: [] };
  }
  if (adapter.mode === "off") {
    return { block: EMPTY_BLOCK, citations: [] };
  }
  let raw: { results: QueryResult[]; truncated: boolean; query_ms: number };
  try {
    raw = await adapter.queryContext(opts.query, {
      limit: opts.limit ?? 5,
      timeout_ms: opts.timeout_ms ?? 8000,
    });
  } catch (err) {
    console.warn(
      `gbrain retrieval: adapter threw — ${err instanceof Error ? err.message : String(err)}`,
    );
    return { block: EMPTY_BLOCK, citations: [] };
  }
  if (raw.results.length === 0) {
    return { block: EMPTY_BLOCK, citations: [] };
  }
  return assembleBlock(raw.results, raw.truncated);
}

function assembleBlock(results: QueryResult[], inputTruncated: boolean): RetrievedBlock {
  const citations: string[] = [];
  const parts: string[] = [];
  let totalChars = 0;
  let dropped = 0;
  let blockTruncated = inputTruncated;

  for (const r of results) {
    const framed = renderResult(r);
    if (framed === null) {
      dropped++;
      continue;
    }
    if (totalChars + framed.length > MAX_TOTAL_CHARS) {
      blockTruncated = true;
      dropped = results.length - parts.length;
      break;
    }
    parts.push(framed);
    citations.push(r.slug);
    totalChars += framed.length;
  }

  if (parts.length === 0) {
    return { block: EMPTY_BLOCK, citations: [] };
  }
  const tail = blockTruncated
    ? `\n<gbrain-memory-truncated count="${dropped}" />`
    : "";
  return { block: parts.join("\n") + tail, citations };
}

function renderResult(r: QueryResult): string | null {
  const sanitized = sanitizeText(r.text);
  if (sanitized === null) {
    return `<gbrain-memory slug="${escapeAttr(r.slug)}" score="${formatScore(r.score)}" suppressed="injection-heuristic" />`;
  }
  const quoted = sanitized
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  return (
    `<gbrain-memory slug="${escapeAttr(r.slug)}" score="${formatScore(r.score)}">\n` +
    quoted +
    `\n</gbrain-memory>`
  );
}

/**
 * Returns sanitized text, or null if the result should be suppressed entirely
 * (e.g. injection-heuristic match).
 */
function sanitizeText(input: string): string | null {
  if (!input) return "";
  // 1. Strip control chars except \n \t.
  let s = input.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");
  // 2. Process line-by-line for role markers and length caps.
  const lines = s.split(/\r?\n/);
  let markerCount = 0;
  const out: string[] = [];
  for (const orig of lines) {
    let line = orig;
    let matched = false;
    for (const re of ROLE_MARKERS) {
      if (re.test(line)) {
        matched = true;
        break;
      }
    }
    if (matched) {
      markerCount++;
      line = "· [marker stripped]";
    }
    // 3. Escape braces to prevent template re-substitution.
    line = line.split("{{").join("{ {").split("}}").join("} }");
    // 4. Cap per-line length.
    if (line.length > MAX_PER_LINE_CHARS) {
      line = line.slice(0, MAX_PER_LINE_CHARS - 12) + "…[truncated]";
    }
    out.push(line);
  }
  // 5. Injection-heuristic: if marker density is high, suppress entirely.
  const denom = Math.max(1, lines.length);
  if (markerCount / denom > ROLE_MARKER_DENSITY_THRESHOLD && markerCount >= 2) {
    return null;
  }
  // 6. Cap per-result body length.
  let joined = out.join("\n");
  if (joined.length > MAX_PER_RESULT_CHARS) {
    joined = joined.slice(0, MAX_PER_RESULT_CHARS - 14) + "\n…[truncated]";
  }
  return joined;
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function formatScore(n: number): string {
  if (!Number.isFinite(n)) return "0.00";
  return n.toFixed(2);
}

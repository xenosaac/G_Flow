#!/usr/bin/env bun
import { Buffer } from "node:buffer";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import {
  UserCheck,
  isSafeRelativePath,
  isSafeRelativeRoute,
  type UserCheckT,
} from "../../artifacts/contract.ts";

interface AssertionSpec {
  id: string;
  text: string;
  evidence_required: string;
  user_check: UserCheckT;
}

interface UserTestSpec {
  target_url: string;
  assertions: AssertionSpec[];
}

interface Result {
  assertion_id: string;
  outcome: "pass" | "fail";
  detail: string;
  evidence?: string;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const POLL_MS = 100;

async function main(): Promise<void> {
  const stdin = await readStdin();
  const spec = parseSpec(stdin);
  const browser = await launchBrowser();
  try {
    const results: Result[] = [];
    for (const assertion of spec.assertions) {
      results.push(await runAssertion(browser, spec, assertion));
    }
    process.stdout.write(JSON.stringify({ results }) + "\n");
  } finally {
    await browser.close().catch(() => undefined);
  }
}

async function readStdin(): Promise<string> {
  if (typeof Bun !== "undefined") {
    return await new Response(Bun.stdin.stream()).text();
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseSpec(raw: string): UserTestSpec {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    fail(`stdin was not JSON: ${(err as Error).message}`, 2);
  }
  if (!parsed || typeof parsed !== "object") {
    fail("stdin JSON must be an object", 2);
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.target_url !== "string" || obj.target_url.trim() === "") {
    fail("target_url is required", 2);
  }
  try {
    new URL(obj.target_url);
  } catch {
    fail(`target_url must be an absolute URL: ${obj.target_url}`, 2);
  }
  if (!Array.isArray(obj.assertions)) {
    fail("assertions must be an array", 2);
  }
  const assertions = obj.assertions.map((rawAssertion, idx) => {
    if (!rawAssertion || typeof rawAssertion !== "object") {
      fail(`assertions[${idx}] must be an object`, 2);
    }
    const a = rawAssertion as Record<string, unknown>;
    const userCheck = UserCheck.safeParse(a.user_check);
    if (!userCheck.success) {
      fail(
        `assertions[${idx}].user_check invalid: ${userCheck.error.issues.map((i) => i.message).join("; ")}`,
        2,
      );
    }
    if (typeof a.id !== "string" || a.id.trim() === "") {
      fail(`assertions[${idx}].id is required`, 2);
    }
    return {
      id: a.id,
      text: typeof a.text === "string" ? a.text : "",
      evidence_required:
        typeof a.evidence_required === "string" ? a.evidence_required : "",
      user_check: userCheck.data,
    };
  });
  return { target_url: obj.target_url, assertions };
}

async function launchBrowser(): Promise<Browser> {
  try {
    return await chromium.launch({ headless: true });
  } catch (err) {
    fail(
      `Playwright Chromium could not launch. Run \`bunx playwright install chromium\`. ${(err as Error).message}`,
      3,
    );
  }
}

async function runAssertion(
  browser: Browser,
  spec: UserTestSpec,
  assertion: AssertionSpec,
): Promise<Result> {
  const timeoutMs = assertion.user_check.timeout_ms ?? DEFAULT_TIMEOUT_MS;
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(timeoutMs);
  page.setDefaultNavigationTimeout(timeoutMs);

  try {
    await startPage(page, spec.target_url, assertion.user_check);
    for (const step of assertion.user_check.steps) {
      switch (step.kind) {
        case "goto":
          await page.goto(relativeUrl(spec.target_url, step.path), {
            waitUntil: "domcontentloaded",
          });
          break;
        case "fill":
          await page.fill(step.selector, step.value);
          break;
        case "click":
          await page.click(step.selector);
          break;
        case "press":
          await page.press(step.selector, step.key);
          break;
        case "expect_text":
          await waitFor(timeoutMs, async () => {
            const text = await page.locator(step.selector).first().innerText();
            if (!text.includes(step.text)) {
              throw new Error(
                `${step.selector} text did not include "${step.text}"; got "${truncate(text, 160)}"`,
              );
            }
          });
          break;
        case "expect_value":
          await waitFor(timeoutMs, async () => {
            const value = await page.locator(step.selector).first().inputValue();
            if (value !== step.value) {
              throw new Error(
                `${step.selector} value was "${value}", expected "${step.value}"`,
              );
            }
          });
          break;
        case "expect_url":
          await waitFor(timeoutMs, async () => {
            const url = page.url();
            if (!url.includes(step.contains)) {
              throw new Error(`url "${url}" did not include "${step.contains}"`);
            }
          });
          break;
        case "expect_count":
          await waitFor(timeoutMs, async () => {
            const count = await page.locator(step.selector).count();
            if (count !== step.count) {
              throw new Error(
                `${step.selector} count was ${count}, expected ${step.count}`,
              );
            }
          });
          break;
      }
    }
    return {
      assertion_id: assertion.id,
      outcome: "pass",
      detail: `browser_flow passed at ${page.url()}`,
      evidence: page.url(),
    };
  } catch (err) {
    return {
      assertion_id: assertion.id,
      outcome: "fail",
      detail: err instanceof Error ? err.message : String(err),
      evidence: page.url(),
    };
  } finally {
    await context.close().catch(() => undefined);
  }
}

async function startPage(
  page: Page,
  targetUrl: string,
  userCheck: UserCheckT,
): Promise<void> {
  if (userCheck.start === "target_url") {
    await page.goto(targetUrl, { waitUntil: "domcontentloaded" });
    return;
  }
  if (!userCheck.path || !isSafeRelativePath(userCheck.path)) {
    throw new Error("file user_check requires a safe relative path");
  }
  await page.goto(pathToFileURL(resolve(process.cwd(), userCheck.path)).toString(), {
    waitUntil: "domcontentloaded",
  });
}

function relativeUrl(targetUrl: string, path: string): string {
  if (!isSafeRelativeRoute(path)) {
    throw new Error(`unsafe goto.path: ${path}`);
  }
  if (path.startsWith("/")) {
    const base = new URL(targetUrl);
    return new URL(path, `${base.protocol}//${base.host}`).toString();
  }
  const base = targetUrl.endsWith("/") ? targetUrl : `${targetUrl}/`;
  return new URL(path, base).toString();
}

async function waitFor(timeoutMs: number, fn: () => Promise<void>): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown = null;
  while (Date.now() <= deadline) {
    try {
      await fn();
      return;
    } catch (err) {
      last = err;
      await sleep(POLL_MS);
    }
  }
  throw last instanceof Error ? last : new Error(String(last ?? "timed out"));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}...`;
}

function fail(message: string, exitCode: number): never {
  process.stderr.write(`playwright-user-test: ${message}\n`);
  process.exit(exitCode);
}

main().catch((err) => {
  fail(err instanceof Error ? err.stack || err.message : String(err), 3);
});

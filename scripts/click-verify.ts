#!/usr/bin/env bun
/**
 * scripts/click-verify.ts — happy-dom browser-click verifier for the static
 * todo demo. Loads the generated index.html, types "Buy milk", clicks the
 * Add Todo button, and asserts the new item appears in the list.
 *
 * Usage:
 *   bun scripts/click-verify.ts <path-to-index.html> [text-to-add]
 *
 * Exit codes:
 *   0 — list contains the typed text after the click
 *   1 — list missing or text not present
 *  64 — bad usage
 */
import { readFile } from "node:fs/promises";
import { loadStaticHtml } from "./load-static-html.ts";

const path = process.argv[2];
const text = process.argv[3] ?? "Buy milk";
if (!path) {
  console.error("usage: bun scripts/click-verify.ts <path-to-index.html> [text]");
  process.exit(64);
}

const html = await readFile(path, "utf8");
const page = await loadStaticHtml(html);
const { document: doc } = page;

const input = doc.getElementById("todo-input");
const button = doc.getElementById("add-todo");
const list = doc.getElementById("todo-list");

if (!input || !button || !list) {
  console.error(
    `click-verify: missing required elements ` +
      `(todo-input=${!!input}, add-todo=${!!button}, todo-list=${!!list})`,
  );
  await page.close();
  process.exit(1);
}

input.value = text;
button.click();

const items = Array.from(list.children as Iterable<{ textContent: string }>).map(
  (li) => (li.textContent ?? "").trim(),
);
const ok = items.some((t) => t.includes(text));
await page.close();

if (ok) {
  console.log(
    `click-verify: PASS — typed "${text}", clicked Add Todo, list now contains ` +
      JSON.stringify(items),
  );
  process.exit(0);
}
console.error(
  `click-verify: FAIL — after click, list was ${JSON.stringify(items)} (expected to contain "${text}")`,
);
process.exit(1);

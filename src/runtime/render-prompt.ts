import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = join(HERE, "..", "prompts");

export async function loadPrompt(name: string): Promise<string> {
  return await readFile(join(PROMPTS_DIR, `${name}.md`), "utf8");
}

export function renderPrompt(template: string, vars: Record<string, string>): string {
  let out = template;
  for (const [k, v] of Object.entries(vars)) {
    out = out.replaceAll(`{{${k}}}`, v);
  }
  return out;
}

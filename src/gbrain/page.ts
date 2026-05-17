import type { GbrainSnapshotV2T } from "./snapshot.ts";

export interface RenderedPage {
  slug: string;
  content: string;
}

/**
 * Sanitize a single slug segment to GBrain's kebab-case grammar:
 * lowercase, ASCII-alphanumeric + hyphens only, no underscores, no double hyphens,
 * no leading/trailing hyphens. Empty / unrenderable input falls back to "x".
 */
export function slugifySegment(input: string): string {
  if (!input) return "x";
  const s = String(input).toLowerCase();
  const replaced = s.replace(/[^a-z0-9]+/g, "-");
  const collapsed = replaced.replace(/-+/g, "-");
  const trimmed = collapsed.replace(/^-+|-+$/g, "");
  return trimmed || "x";
}

/** Compact ISO timestamp for slug suffix: YYYYMMDD-HHMMSS. */
function tsShort(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return slugifySegment(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`
  );
}

function shortSubject(snapshot: GbrainSnapshotV2T): string {
  const p = snapshot.payload;
  if (p.feature_id) return p.feature_id;
  if (p.milestone_id) return p.milestone_id;
  if (snapshot.kind === "plan_created" || snapshot.kind === "flow_complete") return snapshot.flow_id;
  return snapshot.kind;
}

function humanTitle(snapshot: GbrainSnapshotV2T): string {
  const subject = shortSubject(snapshot);
  return `G_Flow · ${snapshot.kind} · ${subject} · ${snapshot.recorded_at}`;
}

function renderTags(snapshot: GbrainSnapshotV2T): string[] {
  const out = ["gflow", slugifySegment(snapshot.flow_id), slugifySegment(snapshot.kind)];
  const p = snapshot.payload;
  if (p.feature_id) out.push(slugifySegment(p.feature_id));
  if (p.milestone_id) out.push(slugifySegment(p.milestone_id));
  return Array.from(new Set(out));
}

function renderSummary(snapshot: GbrainSnapshotV2T): string {
  const p = snapshot.payload;
  const lines: string[] = [];
  switch (snapshot.kind) {
    case "plan_created":
      lines.push(`Phase 1 planning completed for flow ${snapshot.flow_id}.`);
      if (p.goal) lines.push(`Goal: ${p.goal}`);
      if (p.contract_summary) {
        lines.push(
          `Contract: ${p.contract_summary.milestone_count} milestones / ${p.contract_summary.feature_count} features / ${p.contract_summary.assertion_count} assertions (hash ${p.contract_hash}).`,
        );
      }
      break;
    case "feature_close": {
      const title = p.feature_title ? ` ('${p.feature_title}')` : "";
      lines.push(`Feature ${p.feature_id}${title} closed under milestone ${p.milestone_id}.`);
      if (p.screwdriver) {
        const passed = p.screwdriver.assertion_outcomes.filter((o) => o.outcome === "pass").length;
        const total = p.screwdriver.assertion_outcomes.length;
        lines.push(`Screwdriver: ${p.screwdriver.status} (${passed}/${total} assertions passed).`);
      }
      if (p.user_test) {
        const passed = p.user_test.assertion_outcomes.filter((o) => o.outcome === "pass").length;
        const total = p.user_test.assertion_outcomes.length;
        lines.push(`User test: ${p.user_test.status} (${passed}/${total} assertions passed).`);
      }
      if (p.handoff) {
        lines.push(
          `Handoff: ${p.handoff.files_touched.length} files touched, ${p.handoff.commands_run.length} commands run.`,
        );
      }
      break;
    }
    case "milestone_close":
      lines.push(`Milestone ${p.milestone_id} closed in flow ${snapshot.flow_id}.`);
      break;
    case "flow_complete":
      lines.push(`Flow ${snapshot.flow_id} reached completion.`);
      if (p.goal) lines.push(`Goal: ${p.goal}`);
      break;
    case "worker_handoff": {
      const title = p.feature_title ? ` ('${p.feature_title}')` : "";
      lines.push(`Worker handoff for feature ${p.feature_id}${title}.`);
      if (p.handoff) {
        lines.push(`Files touched: ${p.handoff.files_touched.slice(0, 6).join(", ") || "(none)"}.`);
        if (p.handoff.deviations) lines.push(`Deviations: ${p.handoff.deviations}`);
        if (p.handoff.next_worker_hints) lines.push(`Hints: ${p.handoff.next_worker_hints}`);
      }
      break;
    }
    case "validator_report": {
      const v = p.screwdriver ?? p.user_test;
      lines.push(
        `Validator report for feature ${p.feature_id}: status=${v?.status ?? "unknown"}, hint=${v?.steward_hint ?? "NONE"}.`,
      );
      break;
    }
    case "steward_decision":
      lines.push(
        `Steward decision for feature ${p.feature_id}: outcome=${p.steward_decision?.outcome}, attempt=${p.steward_decision?.attempt}.`,
      );
      if (p.steward_decision?.body_md_excerpt) {
        lines.push(`Excerpt: ${p.steward_decision.body_md_excerpt}`);
      }
      break;
    case "steward_triage":
      lines.push(
        `Steward triage for feature ${p.feature_id}: classification=${p.triage?.classification}.`,
      );
      if (p.triage?.rationale) lines.push(`Rationale: ${p.triage.rationale}`);
      break;
  }
  return lines.join(" ");
}

/** YAML-emit a string value safely. */
function yamlString(v: string): string {
  if (/^[A-Za-z0-9._\-+/ ]*$/.test(v) && !/^(true|false|null|yes|no|on|off)$/i.test(v) && v.length > 0 && !/^[0-9]/.test(v)) {
    return v;
  }
  return JSON.stringify(v);
}

/** Render a structured `gflow:` namespace block at indent depth 0. */
function renderGflowNamespace(snapshot: GbrainSnapshotV2T): string {
  const p = snapshot.payload;
  const lines: string[] = ["gflow:"];
  lines.push(`  schema_version: ${snapshot.schema_version}`);
  lines.push(`  kind: ${yamlString(snapshot.kind)}`);
  lines.push(`  flow_id: ${yamlString(snapshot.flow_id)}`);
  if (p.feature_id) lines.push(`  feature_id: ${yamlString(p.feature_id)}`);
  if (p.milestone_id) lines.push(`  milestone_id: ${yamlString(p.milestone_id)}`);
  if (p.feature_title) lines.push(`  feature_title: ${yamlString(p.feature_title)}`);
  if (p.contract_hash) lines.push(`  contract_hash: ${yamlString(p.contract_hash)}`);
  lines.push(`  recorded_at: ${yamlString(snapshot.recorded_at)}`);
  lines.push(`  source_id: ${yamlString(snapshot.source_id)}`);
  lines.push(`  gflow_version: ${yamlString(snapshot.gflow_version)}`);
  if (p.target_dir) lines.push(`  target_dir: ${yamlString(p.target_dir)}`);
  if (p.target_url) lines.push(`  target_url: ${yamlString(p.target_url)}`);
  if (p.artifact_paths && p.artifact_paths.length > 0) {
    lines.push(`  artifact_paths:`);
    for (const path of p.artifact_paths) lines.push(`    - ${yamlString(path)}`);
  }
  return lines.join("\n");
}

/**
 * Convert a snapshot into a GBrain-conformant markdown page:
 * kebab-case slug, frontmatter with `type: note` and a `gflow:` namespace
 * preserving original ids verbatim, human Summary paragraph, and full payload JSON.
 */
export function renderPage(snapshot: GbrainSnapshotV2T): RenderedPage {
  const sourceSeg = slugifySegment(snapshot.source_id);
  const flowSeg = slugifySegment(snapshot.flow_id);
  const kindSeg = slugifySegment(snapshot.kind);
  const subjectSeg = slugifySegment(shortSubject(snapshot));
  const tsSeg = tsShort(snapshot.recorded_at);
  const slug = `gflow/${sourceSeg}/${flowSeg}/${kindSeg}-${subjectSeg}-${tsSeg}`;

  const title = humanTitle(snapshot);
  const tags = renderTags(snapshot);
  const summary = renderSummary(snapshot);
  const payloadJson = JSON.stringify(snapshot.payload, null, 2);

  const content =
    `---\n` +
    `type: note\n` +
    `title: ${yamlString(title)}\n` +
    `tags: [${tags.map(yamlString).join(", ")}]\n` +
    renderGflowNamespace(snapshot) +
    `\n---\n\n` +
    `## Summary\n\n${summary}\n\n` +
    `## Payload\n\n` +
    "```json\n" +
    payloadJson +
    "\n```\n";

  return { slug, content };
}
